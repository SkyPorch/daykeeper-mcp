import { createHash } from "node:crypto";
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  originValidationResponse,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthMetadata,
  type ServerEventBus,
  type ServerNotifier,
} from "@modelcontextprotocol/server";
import { validateOptions, type DaykeeperMcpOptions } from "./config.ts";
import {
  createDaykeeperMcpServerForRuntime,
  type DaykeeperMcpRuntime,
} from "./server.ts";

export const MAX_HTTP_REQUEST_BYTES = 1_048_576;
export const MAX_HTTP_RESPONSE_BYTES = 1_572_864;
export const MAX_HTTP_REQUEST_READ_MS = 10_000;
export const MAX_HTTP_AUTHENTICATION_MS = 5_000;
export const MAX_HTTP_RESPONSE_READ_MS = 65_000;
export const MAX_HTTP_CONCURRENT_REQUESTS = 32;
export const MAX_HTTP_CONCURRENT_AUTHENTICATIONS = 64;
export const MAX_HTTP_CONCURRENT_REQUESTS_PER_PRINCIPAL = 4;

const MAX_CONFIGURED_REQUEST_BYTES = 4_194_304;
const MAX_CONFIGURED_CONCURRENCY = 256;
const MAX_PRINCIPAL_ID_BYTES = 256;
const MAX_SCOPE_COUNT = 64;
const MAX_SCOPE_BYTES = 128;
const MAX_RECENT_DOWNSTREAM_BINDINGS = 4_096;
const CORS_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
].join(", ");

type RemoteDaykeeperOptions = Extract<
  DaykeeperMcpOptions,
  { accessToken: string }
> & { readonly scopes: readonly string[] };

export interface DaykeeperMcpVerifiedAuthInfo extends AuthInfo {
  expiresAt: number;
  resource: URL;
  extra: {
    /** Stable platform principal selected by the authorization grant. */
    daykeeperPrincipalId: string;
    /** Opaque platform grant binding; tenant membership stays server-side. */
    daykeeperGrantId: string;
  };
}

export interface DaykeeperMcpVerifierContext {
  readonly signal: AbortSignal;
  readonly resourceServerUrl: URL;
}

export interface DaykeeperMcpTokenVerifier {
  verifyAccessToken(
    token: string,
    context: DaykeeperMcpVerifierContext,
  ): Promise<DaykeeperMcpVerifiedAuthInfo>;
}

export interface DaykeeperMcpPrincipalContext {
  readonly signal: AbortSignal;
}

export interface DaykeeperMcpHttpPrincipal {
  /** Stable, opaque principal identifier used only for request isolation. */
  readonly principalId: string;
  /** Must match the opaque grant binding returned by the token verifier. */
  readonly grantId: string;
  /** Expiry of the downstream management token, in seconds since epoch. */
  readonly downstreamExpiresAt: number;
  /**
   * A separate, principal-scoped downstream credential. It must not be the
   * incoming MCP bearer token.
   */
  readonly daykeeper: RemoteDaykeeperOptions;
}

export interface DaykeeperMcpHttpOptions {
  /** Canonical public MCP resource URL, including its endpoint path. */
  readonly resourceServerUrl: URL;
  /** Exact, canonical management API URL allowed for downstream SDK calls. */
  readonly daykeeperApiUrl: URL;
  /** RFC 8414 metadata for the authorization server trusted by this host. */
  readonly oauthMetadata: OAuthMetadata;
  /** Validates expiry, revocation, audience and scopes for the MCP bearer. */
  readonly verifier: DaykeeperMcpTokenVerifier;
  /**
   * Resolves an authenticated MCP identity to one tenant-scoped downstream
   * credential. Return null to refuse the principal. Never return the incoming
   * MCP bearer token or a shared cross-tenant credential.
   */
  readonly resolvePrincipal: (
    authInfo: Readonly<DaykeeperMcpVerifiedAuthInfo>,
    context: DaykeeperMcpPrincipalContext,
  ) =>
    | DaykeeperMcpHttpPrincipal
    | null
    | Promise<DaykeeperMcpHttpPrincipal | null>;
  /** Hostnames only. The canonical resource hostname must be included. */
  readonly allowedHostnames: readonly string[];
  /** Exact HTTPS origins allowed to call the MCP endpoint from a browser. */
  readonly allowedOrigins?: readonly string[];
  readonly requiredScopes?: readonly string[];
  readonly scopesSupported?: readonly string[];
  readonly serviceDocumentationUrl?: URL;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestReadTimeoutMs?: number;
  readonly responseReadTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxConcurrentAuthentications?: number;
  readonly maxConcurrentRequestsPerPrincipal?: number;
  readonly onerror?: (message: string) => void;
}

export interface DaykeeperMcpHttpHandler {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
  readonly notify: ServerNotifier;
  readonly bus: ServerEventBus;
}

interface ValidatedHttpOptions {
  readonly resourceServerUrl: URL;
  readonly daykeeperApiUrl: URL;
  readonly metadataOptions: Parameters<typeof oauthMetadataResponse>[1];
  readonly resourceMetadataUrl: string;
  readonly allowedHostnames: string[];
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedOriginHostnames: string[];
  readonly requiredScopes: string[];
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly requestReadTimeoutMs: number;
  readonly responseReadTimeoutMs: number;
  readonly authenticationTimeoutMs: number;
  readonly maxConcurrentRequests: number;
  readonly maxConcurrentAuthentications: number;
  readonly maxConcurrentRequestsPerPrincipal: number;
}

/**
 * Build a fetch-native, per-request Streamable HTTP resource server.
 *
 * This is a mounting primitive, not an OAuth authorization server or a Node
 * listener. The host remains responsible for TLS, trusted proxy handling,
 * OAuth consent/token issuance, credential exchange and durable audit logs.
 */
export function createDaykeeperMcpHttpHandler(
  options: DaykeeperMcpHttpOptions,
): DaykeeperMcpHttpHandler {
  const config = validateHttpOptions(options);
  const runtime: DaykeeperMcpRuntime = Object.freeze({
    transport: "streamable_http",
    hostedOAuth: true,
    http: Object.freeze({
      maximumConcurrentRequests: config.maxConcurrentRequests,
      maximumConcurrentAuthentications: config.maxConcurrentAuthentications,
      maximumConcurrentRequestsPerPrincipal:
        config.maxConcurrentRequestsPerPrincipal,
      maximumRequestBytes: config.maxRequestBytes,
      maximumResponseBytes: config.maxResponseBytes,
      requestReadTimeoutMs: config.requestReadTimeoutMs,
      responseReadTimeoutMs: config.responseReadTimeoutMs,
      authenticationTimeoutMs: config.authenticationTimeoutMs,
    }),
  });
  const principals = new WeakMap<AuthInfo, DaykeeperMcpHttpPrincipal>();
  const inFlightByPrincipal = new Map<string, number>();
  const downstreamBindings = new Map<
    string,
    {
      readonly principalId: string;
      readonly grantId: string;
      readonly expiresAt: number;
    }
  >();
  const activeDownstreamBindings = new Map<
    string,
    {
      readonly principalId: string;
      readonly grantId: string;
      count: number;
    }
  >();
  const lifetime = new AbortController();
  let authenticating = 0;
  let inFlight = 0;
  let closed = false;
  const verifyAccessToken = options.verifier.verifyAccessToken.bind(
    options.verifier,
  );
  const resolvePrincipal = options.resolvePrincipal;
  const reportError = options.onerror;

  const handler: McpHttpHandler = createMcpHandler(
    ({ authInfo }) => {
      const principal = authInfo && principals.get(authInfo);
      if (!principal)
        throw new Error("Authenticated principal context was unavailable.");
      return createDaykeeperMcpServerForRuntime(principal.daykeeper, runtime);
    },
    {
      legacy: "stateless",
      maxSubscriptions: 0,
      onerror: () => reportError?.("Daykeeper MCP request failed."),
    },
  );
  const fetch = async (request: Request): Promise<Response> => {
    const hostRejection = hostHeaderValidationResponse(
      request,
      config.allowedHostnames,
    );
    if (hostRejection) return hostRejection;

    const metadata = oauthMetadataResponse(request, config.metadataOptions);
    if (metadata) return metadata;

    const requestUrl = new URL(request.url);
    if (
      requestUrl.pathname !== config.resourceServerUrl.pathname ||
      requestUrl.search !== ""
    )
      return safeResponse(404, "MCP endpoint not found.");

    const originRejection = originValidationResponse(
      request,
      config.allowedOriginHostnames,
    );
    if (originRejection) return originRejection;
    const origin = request.headers.get("origin");
    if (origin && !config.allowedOrigins.has(origin))
      return safeResponse(403, "Origin is not allowed.");
    if (request.method === "OPTIONS")
      return withCors(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-headers": CORS_REQUEST_HEADERS,
            "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
            "access-control-max-age": "600",
          },
        }),
        origin,
      );
    if (closed)
      return withCors(
        safeResponse(503, "MCP endpoint is unavailable."),
        origin,
      );

    const contentLength = request.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
        Number(contentLength) > config.maxRequestBytes)
    )
      return withCors(safeResponse(413, "MCP request is too large."), origin);

    const bearer = parseBearer(request.headers.get("authorization"));
    if (bearer === null)
      return withCors(invalidTokenResponse(config.resourceMetadataUrl), origin);
    if (authenticating >= config.maxConcurrentAuthentications)
      return withCors(concurrencyResponse(), origin);
    const requestSignal = AbortSignal.any([request.signal, lifetime.signal]);
    authenticating++;
    const verification = beginInterruptible(
      (signal) =>
        verifyAccessToken(bearer, {
          signal,
          resourceServerUrl: new URL(config.resourceServerUrl.href),
        }),
      config.authenticationTimeoutMs,
      requestSignal,
    );
    void verification.settled.then(() => {
      authenticating--;
    });
    const verificationOutcome = await verification.outcome;
    if (verificationOutcome.kind === "timeout")
      return withCors(
        safeResponse(503, "MCP authentication is unavailable."),
        origin,
      );
    if (verificationOutcome.kind === "aborted")
      return withCors(
        safeResponse(
          closed ? 503 : 499,
          closed
            ? "MCP endpoint is unavailable."
            : "MCP request was cancelled.",
        ),
        origin,
      );
    if (verificationOutcome.kind === "error")
      return withCors(invalidTokenResponse(config.resourceMetadataUrl), origin);
    let auth: DaykeeperMcpVerifiedAuthInfo;
    try {
      auth = validateVerifiedAuth(
        verificationOutcome.value,
        bearer,
        config.resourceServerUrl,
        config.requiredScopes,
      );
    } catch (error) {
      if (error instanceof MissingScopeError)
        return withCors(
          insufficientScopeResponse(
            config.resourceMetadataUrl,
            error.requiredScopes,
          ),
          origin,
        );
      return withCors(invalidTokenResponse(config.resourceMetadataUrl), origin);
    }

    if (inFlight >= config.maxConcurrentRequests)
      return withCors(concurrencyResponse(), origin);
    inFlight++;
    let principal: DaykeeperMcpHttpPrincipal | null = null;
    let principalAdmitted = false;
    let releaseDownstreamBinding: (() => void) | undefined;
    let released = false;
    let releaseInFinally = true;
    const releaseAdmission = () => {
      if (released) return;
      released = true;
      if (principalAdmitted && principal) {
        const current = inFlightByPrincipal.get(principal.principalId) ?? 1;
        if (current <= 1) inFlightByPrincipal.delete(principal.principalId);
        else inFlightByPrincipal.set(principal.principalId, current - 1);
      }
      releaseDownstreamBinding?.();
      inFlight--;
    };
    try {
      const resolution = beginInterruptible(
        (signal) => resolvePrincipal(auth, { signal }),
        config.authenticationTimeoutMs,
        requestSignal,
      );
      const resolutionOutcome = await resolution.outcome;
      if (
        resolutionOutcome.kind === "timeout" ||
        resolutionOutcome.kind === "aborted"
      ) {
        releaseInFinally = false;
        void resolution.settled.then(releaseAdmission);
        return withCors(
          safeResponse(
            resolutionOutcome.kind === "timeout" || closed ? 503 : 499,
            resolutionOutcome.kind === "timeout"
              ? "MCP principal resolution is unavailable."
              : closed
                ? "MCP endpoint is unavailable."
                : "MCP request was cancelled.",
          ),
          origin,
        );
      }
      if (resolutionOutcome.kind === "error")
        throw new Error("principal_resolution_failed");
      if (resolutionOutcome.value === null)
        return withCors(
          safeResponse(403, "This principal cannot access Daykeeper MCP."),
          origin,
        );
      principal = validatePrincipal(
        resolutionOutcome.value,
        auth,
        config.daykeeperApiUrl,
      );
      releaseDownstreamBinding = bindDownstreamCredential(
        downstreamBindings,
        activeDownstreamBindings,
        principal,
      );
      const current = inFlightByPrincipal.get(principal.principalId) ?? 0;
      if (current >= config.maxConcurrentRequestsPerPrincipal)
        return withCors(concurrencyResponse(), origin);
      inFlightByPrincipal.set(principal.principalId, current + 1);
      principalAdmitted = true;
      principals.set(auth, principal);

      const bounded = await boundedRequest(
        request,
        config.maxRequestBytes,
        config.requestReadTimeoutMs,
        requestSignal,
      );
      if (bounded instanceof Response) return withCors(bounded, origin);
      const response = await handler.fetch(bounded, { authInfo: auth });
      principals.delete(auth);
      const boundedOutput = boundedResponse(
        response,
        config.maxResponseBytes,
        config.responseReadTimeoutMs,
        requestSignal,
        releaseAdmission,
      );
      if (boundedOutput.ownsAdmission) releaseInFinally = false;
      return withCors(boundedOutput.response, origin);
    } catch {
      reportError?.("Daykeeper MCP request could not be completed.");
      return withCors(
        safeResponse(503, "MCP request could not be completed."),
        origin,
      );
    } finally {
      principals.delete(auth);
      if (releaseInFinally) releaseAdmission();
    }
  };

  return Object.freeze({
    fetch,
    notify: handler.notify,
    bus: handler.bus,
    close: async () => {
      if (closed) return;
      closed = true;
      lifetime.abort(new Error("Daykeeper MCP handler closed."));
      await handler.close();
      downstreamBindings.clear();
    },
  });
}

type InterruptibleOutcome<Value> =
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "error" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

function beginInterruptible<Value>(
  work: (signal: AbortSignal) => Value | Promise<Value>,
  timeoutMs: number,
  externalSignal: AbortSignal,
): {
  readonly outcome: Promise<InterruptibleOutcome<Value>>;
  readonly settled: Promise<void>;
} {
  if (externalSignal.aborted)
    return {
      outcome: Promise.resolve({ kind: "aborted" }),
      settled: Promise.resolve(),
    };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const interrupted = new Promise<InterruptibleOutcome<Value>>((resolve) => {
    abort = () => {
      controller.abort(new Error("MCP request was cancelled."));
      resolve({ kind: "aborted" });
    };
    externalSignal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort(new Error("MCP operation timed out."));
      resolve({ kind: "timeout" });
    }, timeoutMs);
    timer.unref?.();
  });
  const settledOutcome: Promise<InterruptibleOutcome<Value>> = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value) => ({ kind: "value", value }) as const,
      () => ({ kind: "error" }) as const,
    );
  const settled = settledOutcome.then(() => undefined);
  const outcome = Promise.race([settledOutcome, interrupted]).finally(() => {
    if (timer) clearTimeout(timer);
    externalSignal.removeEventListener("abort", abort);
  });
  return { outcome, settled };
}

async function boundedRequest(
  request: Request,
  maximumBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Request | Response> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ABORTED = Symbol("aborted");
  const READ_TIMED_OUT = Symbol("read_timed_out");
  let stop: () => void = () => undefined;
  const interrupted = new Promise<typeof ABORTED | typeof READ_TIMED_OUT>(
    (resolve) => {
      stop = () => resolve(ABORTED);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(() => resolve(READ_TIMED_OUT), timeoutMs);
      timer.unref?.();
    },
  );
  let interruptedResult: typeof ABORTED | typeof READ_TIMED_OUT | undefined;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next === ABORTED || next === READ_TIMED_OUT) {
        interruptedResult = next;
        break;
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes)
        return safeResponse(413, "MCP request is too large.");
      chunks.push(next.value);
    }
  } catch {
    failed = true;
    return safeResponse(400, "MCP request body could not be read.");
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (failed || interruptedResult || size > maximumBytes) {
      cancelReader(reader);
    }
    try {
      reader.releaseLock();
    } catch {
      /* cleanup is best-effort */
    }
  }
  if (interruptedResult)
    return safeResponse(
      interruptedResult === READ_TIMED_OUT ? 408 : 499,
      interruptedResult === READ_TIMED_OUT
        ? "MCP request body was not received in time."
        : "MCP request was cancelled.",
    );
  const body = Buffer.concat(chunks, size);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body.byteLength === 0 ? null : body,
    signal,
  });
}

function validateHttpOptions(
  options: DaykeeperMcpHttpOptions,
): ValidatedHttpOptions {
  try {
    const resourceServerUrl = new URL(options.resourceServerUrl.href);
    if (
      resourceServerUrl.protocol !== "https:" ||
      resourceServerUrl.username ||
      resourceServerUrl.password ||
      resourceServerUrl.search ||
      resourceServerUrl.hash ||
      resourceServerUrl.pathname === "/" ||
      resourceServerUrl.pathname.endsWith("/")
    )
      throw new Error("invalid_resource_url");
    const daykeeperApiUrl = new URL(options.daykeeperApiUrl.href);
    if (
      daykeeperApiUrl.protocol !== "https:" ||
      daykeeperApiUrl.username ||
      daykeeperApiUrl.password ||
      daykeeperApiUrl.search ||
      daykeeperApiUrl.hash ||
      (daykeeperApiUrl.pathname !== "/" &&
        daykeeperApiUrl.pathname.endsWith("/"))
    )
      throw new Error("invalid_daykeeper_api_url");
    const oauthMetadata = structuredClone(options.oauthMetadata);
    const allowedHostnames = unique(
      options.allowedHostnames.map(normalizeHostname),
    );
    if (!allowedHostnames.includes(resourceServerUrl.hostname))
      throw new Error("resource_host_not_allowed");
    const allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map(normalizeOrigin),
    );
    const allowedOriginHostnames = [
      ...new Set([...allowedOrigins].map((origin) => new URL(origin).hostname)),
    ];
    const requiredScopes = normalizeScopes(options.requiredScopes ?? []);
    const scopesSupported = normalizeScopes(options.scopesSupported ?? []);
    if (
      scopesSupported.length > 0 &&
      requiredScopes.some((scope) => !scopesSupported.includes(scope))
    )
      throw new Error("required_scope_not_supported");
    if (!oauthMetadata.code_challenge_methods_supported?.includes("S256"))
      throw new Error("pkce_s256_required");
    if (!oauthMetadata.response_types_supported?.includes("code"))
      throw new Error("authorization_code_response_required");
    if (
      oauthMetadata.grant_types_supported &&
      !oauthMetadata.grant_types_supported.includes("authorization_code")
    )
      throw new Error("authorization_code_required");
    for (const endpoint of [
      oauthMetadata.issuer,
      oauthMetadata.authorization_endpoint,
      oauthMetadata.token_endpoint,
    ]) {
      const parsed = new URL(endpoint);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error("https_oauth_required");
    }
    const serviceDocumentationUrl = options.serviceDocumentationUrl
      ? new URL(options.serviceDocumentationUrl.href)
      : undefined;
    if (
      serviceDocumentationUrl &&
      (serviceDocumentationUrl.protocol !== "https:" ||
        serviceDocumentationUrl.username ||
        serviceDocumentationUrl.password)
    )
      throw new Error("https_documentation_required");
    const metadataOptions = {
      oauthMetadata,
      resourceServerUrl,
      ...(serviceDocumentationUrl ? { serviceDocumentationUrl } : {}),
      ...(scopesSupported.length > 0 ? { scopesSupported } : {}),
      resourceName: "Daykeeper MCP",
    };
    buildOAuthProtectedResourceMetadata(metadataOptions);
    return Object.freeze({
      resourceServerUrl,
      daykeeperApiUrl,
      metadataOptions,
      resourceMetadataUrl:
        getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
      allowedHostnames,
      allowedOrigins,
      allowedOriginHostnames,
      requiredScopes,
      maxRequestBytes: boundedInteger(
        options.maxRequestBytes,
        MAX_HTTP_REQUEST_BYTES,
        1_024,
        MAX_CONFIGURED_REQUEST_BYTES,
      ),
      maxResponseBytes: boundedInteger(
        options.maxResponseBytes,
        MAX_HTTP_RESPONSE_BYTES,
        1_024,
        MAX_CONFIGURED_REQUEST_BYTES,
      ),
      requestReadTimeoutMs: boundedInteger(
        options.requestReadTimeoutMs,
        MAX_HTTP_REQUEST_READ_MS,
        1_000,
        30_000,
      ),
      responseReadTimeoutMs: boundedInteger(
        options.responseReadTimeoutMs,
        MAX_HTTP_RESPONSE_READ_MS,
        1_000,
        120_000,
      ),
      authenticationTimeoutMs: boundedInteger(
        options.authenticationTimeoutMs,
        MAX_HTTP_AUTHENTICATION_MS,
        500,
        30_000,
      ),
      maxConcurrentRequests: boundedInteger(
        options.maxConcurrentRequests,
        MAX_HTTP_CONCURRENT_REQUESTS,
        1,
        MAX_CONFIGURED_CONCURRENCY,
      ),
      maxConcurrentAuthentications: boundedInteger(
        options.maxConcurrentAuthentications,
        MAX_HTTP_CONCURRENT_AUTHENTICATIONS,
        1,
        MAX_CONFIGURED_CONCURRENCY,
      ),
      maxConcurrentRequestsPerPrincipal: boundedInteger(
        options.maxConcurrentRequestsPerPrincipal,
        MAX_HTTP_CONCURRENT_REQUESTS_PER_PRINCIPAL,
        1,
        MAX_CONFIGURED_CONCURRENCY,
      ),
    });
  } catch {
    throw new TypeError(
      "Invalid Daykeeper MCP HTTP configuration. Use one canonical HTTPS resource, explicit hosts/origins, OAuth authorization code with PKCE S256, and bounded limits.",
    );
  }
}

function boundedResponse(
  response: Response,
  maximumBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
  releaseAdmission: () => void,
): { readonly response: Response; readonly ownsAdmission: boolean } {
  const declared = response.headers.get("content-length");
  if (declared && /^(0|[1-9][0-9]*)$/.test(declared)) {
    if (Number(declared) > maximumBytes) {
      cancelBody(response.body);
      return {
        response: safeResponse(502, "MCP response exceeded its size limit."),
        ownsAdmission: false,
      };
    }
  }
  if (!response.body) return { response, ownsAdmission: false };
  const reader = response.body.getReader();
  let size = 0;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finalize = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      /* a pending read releases its lock after cancellation settles */
    }
    releaseAdmission();
  };
  const fail = (message: string) => {
    if (finished) return;
    cancelReader(reader);
    try {
      controller?.error(new Error(message));
    } catch {
      /* the consumer may already have cancelled */
    }
    finalize();
  };
  const abort = () => fail("MCP response was cancelled.");
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => fail("MCP response exceeded its read deadline."),
        timeoutMs,
      );
      timer.unref?.();
      if (signal.aborted) abort();
    },
    async pull(streamController) {
      if (finished) return;
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          streamController.close();
          finalize();
          return;
        }
        size += next.value.byteLength;
        if (size > maximumBytes) {
          fail("MCP response exceeded its size limit.");
          return;
        }
        streamController.enqueue(next.value);
      } catch {
        fail("MCP response could not be read.");
      }
    },
    cancel() {
      cancelReader(reader);
      finalize();
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return {
    response: new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    ownsAdmission: true,
  };
}

function validatePrincipal(
  principal: DaykeeperMcpHttpPrincipal,
  authInfo: DaykeeperMcpVerifiedAuthInfo,
  daykeeperApiUrl: URL,
): DaykeeperMcpHttpPrincipal {
  const principalId = boundedIdentifier(principal.principalId);
  const grantId = boundedIdentifier(principal.grantId);
  if (
    principalId !== authInfo.extra.daykeeperPrincipalId ||
    grantId !== authInfo.extra.daykeeperGrantId
  )
    throw new Error("principal_grant_mismatch");
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(principal.downstreamExpiresAt) ||
    principal.downstreamExpiresAt <= now ||
    principal.downstreamExpiresAt > authInfo.expiresAt
  )
    throw new Error("invalid_downstream_expiry");
  const downstream = validateOptions(principal.daykeeper);
  if (
    downstream.credentialMode !== "access_token" ||
    downstream.accessToken === authInfo.token ||
    new URL(downstream.baseUrl).href !== daykeeperApiUrl.href ||
    downstream.scopes === undefined ||
    downstream.scopes.some((scope) => !authInfo.scopes.includes(scope))
  )
    throw new Error("invalid_downstream_credential");
  return Object.freeze({
    principalId,
    grantId,
    downstreamExpiresAt: principal.downstreamExpiresAt,
    daykeeper: Object.freeze({
      baseUrl: downstream.baseUrl,
      accessToken: downstream.accessToken,
      timeoutMs: downstream.timeoutMs,
      enablePlanning: downstream.enablePlanning,
      enableMutations: downstream.enableMutations,
      enableFlowWrites: downstream.enableFlowWrites,
      enableInboxTools: downstream.enableInboxTools,
      scopes: Object.freeze([...downstream.scopes]),
      ...(principal.daykeeper.fetch
        ? { fetch: principal.daykeeper.fetch }
        : {}),
    }),
  });
}

function bindDownstreamCredential(
  recentBindings: Map<
    string,
    {
      readonly principalId: string;
      readonly grantId: string;
      readonly expiresAt: number;
    }
  >,
  activeBindings: Map<
    string,
    {
      readonly principalId: string;
      readonly grantId: string;
      count: number;
    }
  >,
  principal: DaykeeperMcpHttpPrincipal,
): () => void {
  const now = Math.floor(Date.now() / 1_000);
  const fingerprint = createHash("sha256")
    .update(principal.daykeeper.accessToken)
    .digest("base64url");
  const active = activeBindings.get(fingerprint);
  const existing = recentBindings.get(fingerprint);
  if (
    (active &&
      (active.principalId !== principal.principalId ||
        active.grantId !== principal.grantId)) ||
    (existing &&
      (existing.principalId !== principal.principalId ||
        existing.grantId !== principal.grantId))
  )
    throw new Error("downstream_credential_reused_across_grants");
  if (!existing && recentBindings.size >= MAX_RECENT_DOWNSTREAM_BINDINGS) {
    for (const [candidate, binding] of recentBindings) {
      if (binding.expiresAt <= now && !activeBindings.has(candidate))
        recentBindings.delete(candidate);
    }
  }
  // This is a rolling replay-defense cache, not an admission limit. Evict the
  // least-recently observed inactive credential so one population of valid
  // tenants cannot deny service to another. Active credentials are tracked in
  // a separate map and are never evicted while their responses own admission.
  if (!existing && recentBindings.size >= MAX_RECENT_DOWNSTREAM_BINDINGS) {
    for (const candidate of recentBindings.keys()) {
      if (!activeBindings.has(candidate)) {
        recentBindings.delete(candidate);
        break;
      }
    }
  }
  if (recentBindings.size >= MAX_RECENT_DOWNSTREAM_BINDINGS && !existing)
    throw new Error("downstream_binding_capacity_reached");
  if (existing) recentBindings.delete(fingerprint);
  recentBindings.set(fingerprint, {
    principalId: principal.principalId,
    grantId: principal.grantId,
    expiresAt: principal.downstreamExpiresAt,
  });
  if (active) active.count++;
  else
    activeBindings.set(fingerprint, {
      principalId: principal.principalId,
      grantId: principal.grantId,
      count: 1,
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeBindings.get(fingerprint);
    if (!current || current.count <= 1) activeBindings.delete(fingerprint);
    else current.count--;
  };
}

const MAX_MCP_TOKEN_LIFETIME_SECONDS = 3_600;

function validateVerifiedAuth(
  candidate: DaykeeperMcpVerifiedAuthInfo,
  bearer: string,
  expectedResource: URL,
  requiredScopes: readonly string[],
): DaykeeperMcpVerifiedAuthInfo {
  const now = Math.floor(Date.now() / 1_000);
  if (
    !candidate ||
    candidate.token !== bearer ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt <= now ||
    candidate.expiresAt > now + MAX_MCP_TOKEN_LIFETIME_SECONDS ||
    !(candidate.resource instanceof URL)
  )
    throw new Error("invalid_auth_info");
  const resource = new URL(candidate.resource.href);
  // Compare the verified identifier as supplied. Removing a fragment would
  // authorize a different resource (including an explicitly empty fragment).
  if (resource.href !== expectedResource.href)
    throw new Error("invalid_resource");
  const clientId = boundedIdentifier(candidate.clientId);
  const scopes = normalizeScopes(candidate.scopes);
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) throw new MissingScopeError(missing);
  const extra = candidate.extra;
  if (!extra || typeof extra !== "object")
    throw new Error("missing_grant_binding");
  const principalId = boundedIdentifier(extra.daykeeperPrincipalId);
  const grantId = boundedIdentifier(extra.daykeeperGrantId);
  return Object.freeze({
    token: bearer,
    clientId,
    scopes: [...scopes],
    expiresAt: candidate.expiresAt,
    resource: new URL(expectedResource.href),
    extra: Object.freeze({
      daykeeperPrincipalId: principalId,
      daykeeperGrantId: grantId,
    }),
  });
}

class MissingScopeError extends Error {
  constructor(readonly requiredScopes: string[]) {
    super("Required OAuth scopes are missing.");
  }
}

function boundedIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_PRINCIPAL_ID_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("invalid_identifier");
  return value;
}

function normalizeHostname(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value === "")
    throw new Error("invalid_hostname");
  const normalized = value.toLowerCase();
  const parsed = new URL(`https://${normalized}/`);
  if (
    parsed.hostname !== normalized ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/"
  )
    throw new Error("invalid_hostname");
  return normalized;
}

function normalizeOrigin(value: string): string {
  if (typeof value !== "string" || value !== value.trim())
    throw new Error("invalid_origin");
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password
  )
    throw new Error("invalid_origin");
  return parsed.origin;
}

function normalizeScopes(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_SCOPE_COUNT)
    throw new Error("invalid_scopes");
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value === "" ||
      value !== value.trim() ||
      Buffer.byteLength(value) > MAX_SCOPE_BYTES ||
      /[\s"\\]/.test(value)
    )
      throw new Error("invalid_scopes");
  }
  return unique([...values]).sort();
}

function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length)
    throw new Error("duplicate_values");
  return values;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum)
    throw new Error("invalid_limit");
  return selected;
}

function concurrencyResponse(): Response {
  const response = safeResponse(429, "MCP request capacity is full.");
  response.headers.set("retry-after", "1");
  return response;
}

function parseBearer(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function invalidTokenResponse(resourceMetadataUrl: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "www-authenticate": `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
    },
  });
}

function insufficientScopeResponse(
  resourceMetadataUrl: string,
  requiredScopes: readonly string[],
): Response {
  const scope = requiredScopes.join(" ");
  return new Response(JSON.stringify({ error: "insufficient_scope" }), {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadataUrl}"`,
    },
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    /* cancellation is best-effort and never delays the bounded response */
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    /* cancellation is best-effort and never delays the bounded response */
  }
}

function safeResponse(status: number, message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32_000, message },
      id: null,
    },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set(
    "access-control-expose-headers",
    "mcp-session-id, www-authenticate",
  );
  const vary = headers.get("vary");
  headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
