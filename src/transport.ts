import {
  DaykeeperApiError,
  DaykeeperClient,
  DaykeeperTransportError,
} from "@skyporch/daykeeper";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  ENVELOPE_VERSION,
  MAX_CONCURRENT_REQUESTS,
  MAX_INPUT_BYTES,
  MAX_RESPONSE_BYTES,
  type DaykeeperMcpConfig,
} from "./config.ts";
import { createDashboardApi } from "./dashboardApi.ts";
import { McpAdapterError, safeError, type SafeError } from "./errors.ts";
import { outputSchema } from "./schemas.ts";
import { toolEnabled, type Execute, type ToolMetadata } from "./tools.ts";

/**
 * The pinned SDK only accepts HTTPS (or loopback HTTP) base URLs. A hosted
 * deployment may reach the API over a private network by an explicitly
 * allowlisted service name (validated in config.ts). The SDK is then given the
 * same host and path under https, and the bounded transport below maps that
 * one origin back to the configured http origin. Nothing else is rewritten.
 */
function sdkBaseUrl(baseUrl: string): { sdk: string; dispatchOrigin: string } {
  const url = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "http:" || loopback)
    return { sdk: baseUrl, dispatchOrigin: url.origin };
  const virtual = new URL(baseUrl);
  virtual.protocol = "https:";
  if (url.port === "") virtual.port = "80";
  return { sdk: virtual.href.replace(/\/$/, ""), dispatchOrigin: url.origin };
}

export function createExecutor(
  config: DaykeeperMcpConfig,
  transport: typeof globalThis.fetch = globalThis.fetch,
  lifetime?: AbortSignal,
): Execute {
  let inFlight = 0;
  return async (metadata, input, work, signal) => {
    let requestSent = false;
    let adapterFailure: McpAdapterError | undefined;
    let admitted = false;
    const controller = new AbortController();
    const deadline = performance.now() + config.timeoutMs;
    const timeoutError = () =>
      new McpAdapterError(
        "REQUEST_TIMEOUT",
        "The tool exceeded its request deadline. Cancellation does not undo accepted work.",
        true,
      );
    const timer = setTimeout(
      () => controller.abort(timeoutError()),
      config.timeoutMs,
    );
    const cancel = () =>
      controller.abort(
        new McpAdapterError(
          "REQUEST_ABORTED",
          "The tool was cancelled. Cancellation does not undo accepted work.",
        ),
      );
    const dispose = () =>
      controller.abort(
        new McpAdapterError(
          "ADAPTER_CLOSED",
          "The local adapter has closed. Cancellation does not undo accepted work.",
        ),
      );
    signal.addEventListener("abort", cancel, { once: true });
    lifetime?.addEventListener("abort", dispose, { once: true });
    if (lifetime?.aborted) dispose();
    if (signal.aborted) cancel();
    const assertActive = () => {
      if (!controller.signal.aborted && performance.now() >= deadline)
        controller.abort(timeoutError());
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    try {
      assertActive();
      if (!toolEnabled(metadata, config))
        throw new McpAdapterError(
          "TOOL_DISABLED",
          "This write category is not enabled for the local adapter.",
        );
      assertScopes(metadata, config);
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
        throw new McpAdapterError(
          "INPUT_TOO_LARGE",
          "The tool input exceeds the adapter limit.",
        );
      if (inFlight >= MAX_CONCURRENT_REQUESTS)
        throw new McpAdapterError(
          "LOCAL_CONCURRENCY_LIMIT",
          "Wait for an existing tool call to finish before starting another.",
          true,
        );
      inFlight++;
      admitted = true;
      const target = sdkBaseUrl(config.baseUrl);
      const sdkOrigin = new URL(target.sdk).origin;
      const fetch: typeof globalThis.fetch = async (url, init) => {
        try {
          assertActive();
          const actual = new URL(
            typeof url === "string" || url instanceof URL ? url : url.url,
          );
          if (actual.origin !== sdkOrigin)
            throw new McpAdapterError(
              "INVALID_REQUEST_TARGET",
              "The SDK request did not target the configured API origin.",
            );
          const destination =
            sdkOrigin === target.dispatchOrigin
              ? url
              : new URL(
                  `${actual.pathname}${actual.search}`,
                  target.dispatchOrigin,
                );
          // A static credential and a dispatch guard avoid any late request after
          // the caller has cancelled. The SDK cannot redirect or replay a write.
          // Pass-through only: the end client's address chain, so per-client
          // API rate limits see the person rather than this host. Sent only to
          // an explicitly allowlisted internal API host.
          const outgoing = new Headers(init?.headers);
          outgoing.delete("x-forwarded-for");
          const dispatchHost = new URL(
            typeof destination === "string" || destination instanceof URL
              ? destination
              : destination.url,
          ).hostname;
          if (
            config.forwardedFor !== undefined &&
            config.internalHttpHostnames.includes(dispatchHost)
          )
            outgoing.set("x-forwarded-for", config.forwardedFor);
          requestSent = true;
          const pending = Promise.resolve(
            transport(destination, {
              ...init,
              headers: outgoing,
              signal: controller.signal,
              redirect: "error",
              credentials: "omit",
            }),
          );
          void pending.then(
            (response) => {
              if (controller.signal.aborted) cancelBody(response);
            },
            () => undefined,
          );
          const response = await abortable(pending, controller.signal);
          if (response.redirected) {
            cancelBody(response);
            throw new McpAdapterError(
              "REDIRECT_REJECTED",
              "The API returned a redirected response.",
            );
          }
          const bytes = await readBody(
            response,
            controller.signal,
            assertActive,
          );
          assertActive();
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(
            response.body ? Uint8Array.from(bytes).buffer : null,
            {
              status: response.status,
              statusText: response.statusText,
              headers,
            },
          );
        } catch (error) {
          // The pinned SDK normalizes fetch failures. Retain only our own safe
          // bounded-transport failures, never third-party diagnostic details.
          if (error instanceof McpAdapterError) adapterFailure = error;
          throw error;
        }
      };
      const client = new DaykeeperClient({
        baseUrl: target.sdk,
        token: config.accessToken,
        timeoutMs: config.timeoutMs,
        fetch,
      });
      const api = createDashboardApi({
        baseUrl: target.sdk,
        token: config.accessToken,
        fetch,
      });
      const data = await abortable(work(client, api), controller.signal);
      assertActive();
      if (
        !data ||
        typeof data !== "object" ||
        (Array.isArray(data) &&
          data.some(
            (item) => !item || typeof item !== "object" || Array.isArray(item),
          ))
      )
        throw new McpAdapterError(
          "INVALID_API_RESPONSE",
          "The API did not return the expected JSON object or resource list.",
        );
      if (metadata.profile === "dashboard")
        return dashboardResult(metadata, config.accessToken, data as object);
      return result(metadata, config.accessToken, { ok: true, data });
    } catch (error) {
      const details = safeError(
        controller.signal.aborted
          ? controller.signal.reason
          : (adapterFailure ?? error),
        config.accessToken,
      );
      if (
        requestSent &&
        metadata.effect !== "read" &&
        (details.kind === "transport" ||
          [
            "REQUEST_TIMEOUT",
            "REQUEST_ABORTED",
            "ADAPTER_CLOSED",
            "RESPONSE_TOO_LARGE",
            "INVALID_API_RESPONSE",
            "REDIRECT_REJECTED",
            "INTERNAL_ERROR",
          ].includes(details.code) ||
          details.status === 408 ||
          (details.status ?? 0) >= 500 ||
          // The API itself may say a dispatched write's outcome is unknown,
          // for example 409 REQUEST_OUTCOME_UNKNOWN on an idempotent replay.
          ((error instanceof DaykeeperApiError ||
            error instanceof DaykeeperTransportError) &&
            error.outcomeUnknown))
      ) {
        details.mutationOutcome = "unknown";
        details.nextActions = [
          ...new Set([
            ...details.nextActions,
            ...(metadata.requiresActivationTools
              ? ["inspect_activation_with_original_intent"]
              : metadata.requiresClaimTools
                ? ["list_workspace_claims", "reuse_original_idempotency_key"]
                : metadata.name.endsWith("_apply")
                  ? [
                      "inspect_operation_before_retry",
                      "reuse_original_idempotency_key",
                    ]
                  : metadata.requiresIdempotencyKey
                    ? [
                        "inspect_resource_before_retry",
                        "reuse_original_idempotency_key",
                      ]
                    : ["inspect_resource_before_retry"]),
          ]),
        ];
      }
      if (details.code === "IDEMPOTENCY_KEY_REUSED")
        details.nextActions = [
          ...new Set([
            ...details.nextActions,
            "inspect_resource_before_retry",
            "use_a_fresh_key_only_for_a_different_request",
          ]),
        ];
      const failure =
        metadata.profile === "dashboard"
          ? dashboardError(metadata, config.accessToken, details, input)
          : result(metadata, config.accessToken, {
              ok: false,
              error: details,
            });
      // The API refused the bearer itself (revoked, expired or disconnected
      // mid-session): carry the RFC 6750 challenge ChatGPT turns into a
      // "reconnect" prompt. Only for a real API 401, never a local refusal.
      if (
        details.kind === "api" &&
        details.status === 401 &&
        config.resourceMetadataUrl !== undefined
      )
        failure._meta = {
          ...failure._meta,
          "mcp/www_authenticate": [
            `Bearer resource_metadata="${config.resourceMetadataUrl}", error="invalid_token", error_description="Your Daykeeper connection has expired or was revoked. Reconnect Daykeeper to continue."`,
          ],
        };
      return failure;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      lifetime?.removeEventListener("abort", dispose);
      if (admitted) inFlight--;
      if (!controller.signal.aborted)
        controller.abort(
          new McpAdapterError("REQUEST_FINISHED", "The request has finished."),
        );
    }
  };
}

/**
 * A second, local refusal. The API remains the authority on authorization; this
 * only stops a tool whose exact required scope the operator did not declare for
 * the configured credential.
 */
function assertScopes(
  metadata: ToolMetadata,
  config: DaykeeperMcpConfig,
): void {
  // Declared scopes gate writes only. Reading is how an operator inspects an
  // uncertain write, so a minimal write scope list must never refuse
  // daykeeper_flows_get, the exact tool that guidance names. The API still
  // enforces read authorization.
  if (metadata.effect === "read") return;
  if (config.scopes === undefined) {
    if (
      !metadata.requiresFlowWrites &&
      !metadata.requiresActivationTools &&
      !metadata.requiresOperatorWrites
    )
      return;
    throw new McpAdapterError(
      `SCOPES_NOT_DECLARED`,
      `${metadata.requiresActivationTools ? "Inbox activation mutations" : metadata.requiresOperatorWrites ? "Operator conversation replies" : "Flow writes"} require the exact scopes the configured ${config.credentialMode} credential holds to be declared in DAYKEEPER_MCP_SCOPES. This tool needs ${metadata.scopes.join(", ")}.`,
    );
  }
  const granted = config.scopes;
  const missing = metadata.scopes.filter((scope) => !granted.includes(scope));
  if (missing.length > 0)
    throw new McpAdapterError(
      "SCOPE_NOT_GRANTED",
      `The configured ${config.credentialMode} credential does not declare ${missing.join(", ")}, which this tool requires.`,
    );
}

function result(
  metadata: ToolMetadata,
  secret: string,
  value: object,
): CallToolResult {
  const serialized = JSON.stringify({
    schemaVersion: ENVELOPE_VERSION,
    tool: metadata.name,
    effect: metadata.effect,
    ...value,
  });
  const text = serialized
    .split(JSON.stringify(secret).slice(1, -1))
    .join("[REDACTED]");
  const structuredContent = outputSchema.parse(JSON.parse(text));
  return {
    isError: !structuredContent.ok,
    content: [{ type: "text", text }],
    structuredContent,
  };
}

/**
 * Dashboard tools answer with their own flat, per-tool structured content so
 * ChatGPT and the dashboard UI read the fields directly. The access token is
 * redacted from both representations, as in the general envelope.
 */
function dashboardResult(
  metadata: ToolMetadata,
  secret: string,
  data: object,
): CallToolResult {
  const text = redact(JSON.stringify(data), secret);
  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function dashboardError(
  metadata: ToolMetadata,
  secret: string,
  details: SafeError,
  input: unknown,
): CallToolResult {
  const unknown = details.mutationOutcome === "unknown";
  // A send's key is minted before dispatch, so it can always be handed back:
  // the only safe retry of an uncertain send reuses that exact key.
  const key =
    metadata.requiresIdempotencyKey &&
    input &&
    typeof input === "object" &&
    "idempotencyKey" in input &&
    typeof input.idempotencyKey === "string" &&
    /^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
      ? input.idempotencyKey
      : undefined;
  const what = metadata.name === "send_reply" ? "reply" : "change";
  const message =
    details.code === "REQUEST_IN_PROGRESS" && key
      ? `This ${what} is still being processed under idempotencyKey "${key}". Wait, check the current state, and retry only with that same key.`
      : details.code === "IDEMPOTENCY_KEY_REUSED"
        ? `idempotencyKey${key ? ` "${key}"` : ""} was already used for a different ${what}. Check the current state; use a new key only for a genuinely different ${what}.`
        : unknown
          ? key
            ? `The ${metadata.name === "send_reply" ? "reply may already have been sent" : "change may already have been made"}. Check the current state before trying again. To retry, repeat the call with idempotencyKey "${key}"; never with a new key.`
            : "The change may already have been made. Check the current state before trying again."
          : details.status === 401
            ? "Your Daykeeper connection has expired or was revoked. Reconnect Daykeeper to continue."
            : details.message;
  const error = {
    code: details.code,
    message,
    retryable: unknown ? false : details.retryable,
    ...(details.status === undefined ? {} : { status: details.status }),
    ...(unknown ? { outcome: "unknown" as const } : {}),
    ...(key ? { idempotencyKey: key } : {}),
    nextActions: details.nextActions,
    ...(details.correlationId ? { correlationId: details.correlationId } : {}),
  };
  const text = redact(JSON.stringify({ tool: metadata.name, error }), secret);
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function redact(text: string, secret: string): string {
  return text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      assertActive();
      const next = await abortable(reader.read(), signal);
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new McpAdapterError(
          "RESPONSE_TOO_LARGE",
          "The API response exceeds the adapter limit. Request a narrower resource.",
        );
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* preserve the primary result */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* cleanup cannot replace the primary result */
    }
  }
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* cleanup is best-effort and bounded */
  }
}

function abortable<Value>(
  pending: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
