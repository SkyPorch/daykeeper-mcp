import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeInternalHostnames } from "./config.ts";
import {
  DaykeeperMcpVerifierUnavailableError,
  type DaykeeperMcpTokenVerifier,
  type DaykeeperMcpVerifiedAuthInfo,
  type DaykeeperMcpVerifierContext,
} from "./http.ts";

export const MAX_INTROSPECTION_RESPONSE_BYTES = 16_384;
export const DEFAULT_INTROSPECTION_TIMEOUT_MS = 3_000;
export const MAX_INTROSPECTION_CACHE_SECONDS = 30;
export const DEFAULT_INTROSPECTION_NEGATIVE_CACHE_SECONDS = 300;
const MAX_CACHE_ENTRIES = 4_096;
const MAX_NEGATIVE_CACHE_ENTRIES = 16_384;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_SCOPE_COUNT = 64;

export interface DaykeeperIntrospectionVerifierOptions {
  /**
   * RFC 7662 endpoint, for Daykeeper `{internalApiUrl}/oauth/introspect`.
   * HTTPS, or plain HTTP only to loopback or a host in `internalHttpHostnames`.
   */
  readonly introspectionUrl: URL;
  /** Sent as `Authorization: Bearer …` to the introspection endpoint only. */
  readonly clientSecret: string;
  /** Exact private hostnames the endpoint may use over plain HTTP. */
  readonly internalHttpHostnames?: readonly string[];
  /** When the response carries `iss`, it must equal this exactly. */
  readonly issuer?: string;
  /** Per-call budget, 500–10000 ms. Defaults to 3000. */
  readonly timeoutMs?: number;
  /** Positive-result cache lifetime, 0–30 s, never past `exp`. Default 30. */
  readonly cacheSeconds?: number;
  /**
   * How long an `active: false` answer is remembered, 0–3600 s. Default 300.
   * An inactive token never becomes active again, so repeats of the same
   * dead or random bearer are refused without another introspection call.
   * Malformed answers and outages are never cached.
   */
  readonly negativeCacheSeconds?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Clock in milliseconds, for tests. */
  readonly now?: () => number;
}

// RFC 7662 allows more members; the ones this host relies on are strict.
const activeResponse = z.object({
  active: z.literal(true),
  scope: z.string().max(4_096),
  exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  client_id: z.string().min(1).max(MAX_IDENTIFIER_BYTES),
  resource: z.string().min(1).max(2_048),
  daykeeper_principal_id: z.string().min(1).max(MAX_IDENTIFIER_BYTES),
  daykeeper_grant_id: z.string().min(1).max(MAX_IDENTIFIER_BYTES),
  token_type: z.string().max(40).optional(),
  iss: z.string().max(2_048).optional(),
  nbf: z.number().int().nonnegative().optional(),
  iat: z.number().int().nonnegative().optional(),
});
const inactiveResponse = z.object({ active: z.literal(false) });

class InvalidTokenError extends Error {
  constructor() {
    super("The access token is not active.");
    this.name = "InvalidTokenError";
  }
}

/**
 * An `OAuthTokenVerifier` for an RFC 7662 introspection endpoint, shaped for
 * `createDaykeeperMcpHttpHandler`. Inactive or malformed answers are invalid
 * tokens; a timeout, network failure or unexpected status means verification
 * is unavailable (503), so clients are not sent through re-authorization for
 * an outage. Positive results are cached briefly and never past `exp`;
 * `active: false` answers are cached longer, since they are final.
 */
export function createDaykeeperIntrospectionVerifier(
  options: DaykeeperIntrospectionVerifierOptions,
): DaykeeperMcpTokenVerifier {
  const config = validate(options);
  const cache = new Map<
    string,
    { readonly auth: DaykeeperMcpVerifiedAuthInfo; readonly until: number }
  >();
  // sha256(token) -> second until which the token is known inactive.
  const inactive = new Map<string, number>();
  const now = () => Math.floor(config.now() / 1_000);

  const verifyAccessToken = async (
    token: string,
    context: DaykeeperMcpVerifierContext,
  ): Promise<DaykeeperMcpVerifiedAuthInfo> => {
    if (typeof token !== "string" || token.length === 0 || token.length > 4_096)
      throw new InvalidTokenError();
    const key = createHash("sha256").update(token).digest("base64url");
    const cached = cache.get(key);
    if (cached) {
      if (cached.until > now() && cached.auth.expiresAt > now())
        return cached.auth;
      cache.delete(key);
    }
    const knownInactive = inactive.get(key);
    if (knownInactive !== undefined) {
      if (knownInactive > now()) throw new InvalidTokenError();
      inactive.delete(key);
    }
    const body = await introspect(token, context.signal);
    if (
      config.negativeCacheSeconds > 0 &&
      inactiveResponse.safeParse(body).success
    ) {
      if (inactive.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
        for (const [candidate, until] of inactive)
          if (until <= now()) inactive.delete(candidate);
        while (inactive.size >= MAX_NEGATIVE_CACHE_ENTRIES)
          inactive.delete(inactive.keys().next().value as string);
      }
      inactive.set(key, now() + config.negativeCacheSeconds);
      throw new InvalidTokenError();
    }
    const auth = toAuthInfo(token, body, config, now());
    if (config.cacheSeconds > 0) {
      const until = Math.min(now() + config.cacheSeconds, auth.expiresAt);
      if (cache.size >= MAX_CACHE_ENTRIES) {
        for (const [candidate, entry] of cache)
          if (entry.until <= now()) cache.delete(candidate);
        while (cache.size >= MAX_CACHE_ENTRIES)
          cache.delete(cache.keys().next().value as string);
      }
      cache.set(key, { auth, until });
    }
    return auth;
  };

  const introspect = async (
    token: string,
    signal: AbortSignal,
  ): Promise<unknown> => {
    // A plain controller and a strongly held timer: composite or timeout
    // signals can be collected while only weakly referenced, which would
    // leave a stalled call waiting forever instead of failing at the budget.
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, config.timeoutMs);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const stopped = new Promise<never>((_, reject) => {
      const fail = () => reject(new DaykeeperMcpVerifierUnavailableError());
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    stopped.catch(() => undefined);
    let response: Response | undefined;
    try {
      response = await Promise.race([
        config.fetch(config.introspectionUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.clientSecret}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token }).toString(),
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        }),
        stopped,
      ]);
      if (response.redirected || response.status !== 200)
        throw new DaykeeperMcpVerifierUnavailableError();
      const type = response.headers.get("content-type") ?? "";
      if (!/^application\/json(?:\s*;|$)/i.test(type))
        throw new DaykeeperMcpVerifierUnavailableError();
      const text = await readBounded(
        response,
        config.maxResponseBytes,
        stopped,
      );
      return JSON.parse(text) as unknown;
    } catch {
      void response?.body?.cancel().catch(() => undefined);
      throw new DaykeeperMcpVerifierUnavailableError();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  return Object.freeze({ verifyAccessToken });
}

function toAuthInfo(
  token: string,
  body: unknown,
  config: ValidatedConfig,
  now: number,
): DaykeeperMcpVerifiedAuthInfo {
  if (inactiveResponse.safeParse(body).success) throw new InvalidTokenError();
  const parsed = activeResponse.safeParse(body);
  if (!parsed.success) throw new InvalidTokenError();
  const value = parsed.data;
  if (value.exp <= now) throw new InvalidTokenError();
  if (value.nbf !== undefined && value.nbf > now + 60)
    throw new InvalidTokenError();
  if (config.issuer !== undefined && value.iss !== undefined)
    if (value.iss !== config.issuer) throw new InvalidTokenError();
  if (
    value.token_type !== undefined &&
    !/^(?:bearer|access_token)$/i.test(value.token_type)
  )
    throw new InvalidTokenError();
  const scopes = value.scope.split(" ").filter((scope) => scope !== "");
  if (
    scopes.length > MAX_SCOPE_COUNT ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope))
  )
    throw new InvalidTokenError();
  let resource: URL;
  try {
    resource = new URL(value.resource);
  } catch {
    throw new InvalidTokenError();
  }
  for (const identifier of [
    value.client_id,
    value.daykeeper_principal_id,
    value.daykeeper_grant_id,
  ])
    if (
      /[\u0000-\u001f\u007f]/.test(identifier) ||
      identifier !== identifier.trim()
    )
      throw new InvalidTokenError();
  return Object.freeze({
    token,
    clientId: value.client_id,
    scopes: Object.freeze([...scopes]) as string[],
    expiresAt: value.exp,
    resource,
    extra: Object.freeze({
      daykeeperPrincipalId: value.daykeeper_principal_id,
      daykeeperGrantId: value.daykeeper_grant_id,
    }),
  });
}

async function readBounded(
  response: Response,
  maximum: number,
  stopped: Promise<never>,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum)
    throw new DaykeeperMcpVerifierUnavailableError();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new DaykeeperMcpVerifierUnavailableError();
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, size),
  );
}

interface ValidatedConfig {
  readonly introspectionUrl: URL;
  readonly clientSecret: string;
  readonly issuer: string | undefined;
  readonly timeoutMs: number;
  readonly cacheSeconds: number;
  readonly negativeCacheSeconds: number;
  readonly maxResponseBytes: number;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
}

function validate(
  options: DaykeeperIntrospectionVerifierOptions,
): ValidatedConfig {
  try {
    const url = new URL(options.introspectionUrl.href);
    const internal = normalizeInternalHostnames(options.internalHttpHostnames);
    const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          (loopback || internal.includes(url.hostname))
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid_introspection_url");
    if (
      typeof options.clientSecret !== "string" ||
      options.clientSecret.length < 32 ||
      options.clientSecret.length > 1_024 ||
      !/^[\x21-\x7e]+$/.test(options.clientSecret)
    )
      throw new Error("invalid_secret");
    if (
      options.issuer !== undefined &&
      (typeof options.issuer !== "string" ||
        new URL(options.issuer).protocol !== "https:")
    )
      throw new Error("invalid_issuer");
    const integer = (
      value: number | undefined,
      fallback: number,
      minimum: number,
      maximum: number,
    ) => {
      const selected = value ?? fallback;
      if (
        !Number.isInteger(selected) ||
        selected < minimum ||
        selected > maximum
      )
        throw new Error("invalid_limit");
      return selected;
    };
    if (options.fetch !== undefined && typeof options.fetch !== "function")
      throw new Error("invalid_fetch");
    return Object.freeze({
      introspectionUrl: url,
      clientSecret: options.clientSecret,
      issuer: options.issuer,
      timeoutMs: integer(
        options.timeoutMs,
        DEFAULT_INTROSPECTION_TIMEOUT_MS,
        500,
        10_000,
      ),
      cacheSeconds: integer(
        options.cacheSeconds,
        MAX_INTROSPECTION_CACHE_SECONDS,
        0,
        MAX_INTROSPECTION_CACHE_SECONDS,
      ),
      negativeCacheSeconds: integer(
        options.negativeCacheSeconds,
        DEFAULT_INTROSPECTION_NEGATIVE_CACHE_SECONDS,
        0,
        3_600,
      ),
      maxResponseBytes: integer(
        options.maxResponseBytes,
        MAX_INTROSPECTION_RESPONSE_BYTES,
        256,
        65_536,
      ),
      fetch: options.fetch ?? globalThis.fetch,
      now: options.now ?? Date.now,
    });
  } catch {
    throw new TypeError(
      "Invalid Daykeeper introspection configuration. Use an HTTPS (or allowlisted internal HTTP) endpoint, a strong client secret and bounded limits.",
    );
  }
}
