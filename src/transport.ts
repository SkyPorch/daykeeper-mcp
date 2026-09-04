import { DaykeeperClient } from "@skyporch/daykeeper";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  ENVELOPE_VERSION,
  MAX_CONCURRENT_REQUESTS,
  MAX_INPUT_BYTES,
  MAX_RESPONSE_BYTES,
  type DaykeeperMcpConfig,
} from "./config.ts";
import { McpAdapterError, safeError } from "./errors.ts";
import { outputSchema } from "./schemas.ts";
import { toolEnabled, type Execute, type ToolMetadata } from "./tools.ts";

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
      const fetch: typeof globalThis.fetch = async (url, init) => {
        try {
          assertActive();
          const actual = new URL(
            typeof url === "string" || url instanceof URL ? url : url.url,
          );
          if (actual.origin !== new URL(config.baseUrl).origin)
            throw new McpAdapterError(
              "INVALID_REQUEST_TARGET",
              "The SDK request did not target the configured API origin.",
            );
          // A static credential and a dispatch guard avoid any late request after
          // the caller has cancelled. The SDK cannot redirect or replay a write.
          requestSent = true;
          const pending = Promise.resolve(
            transport(url, {
              ...init,
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
        baseUrl: config.baseUrl,
        token: config.accessToken,
        timeoutMs: config.timeoutMs,
        fetch,
      });
      const data = await abortable(work(client), controller.signal);
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
          (details.status ?? 0) >= 500)
      ) {
        details.mutationOutcome = "unknown";
        details.nextActions = [
          ...new Set([
            ...details.nextActions,
            ...(metadata.name.endsWith("_apply")
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
      return result(metadata, config.accessToken, {
        ok: false,
        error: details,
      });
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
    if (!metadata.requiresFlowWrites) return;
    throw new McpAdapterError(
      `SCOPES_NOT_DECLARED`,
      `Flow writes require the exact scopes the configured ${config.credentialMode} credential holds to be declared in DAYKEEPER_MCP_SCOPES. This tool needs ${metadata.scopes.join(", ")}.`,
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
