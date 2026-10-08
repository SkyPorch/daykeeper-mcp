import {
  DaykeeperApiError,
  DaykeeperTransportError,
} from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

/**
 * The few Daykeeper Dashboard calls the published Node SDK (0.3.0) does not
 * expose yet: the caller's own profile, paginated conversation reads,
 * idempotent operator replies, conversation status and the customer email
 * switch.
 *
 * TODO(sdk): switch each method to the SDK once @skyporch/daykeeper ships
 * `me.get`, paginated `operatorConversations.list/messages`, an
 * `idempotencyKey` option on `operatorConversations.reply`,
 * `operatorConversations.setStatus` and `customerEmail.get/set`.
 *
 * Every request goes through the executor's bounded transport, so it inherits
 * the same safety rails as SDK calls: the configured origin only, no
 * redirects, the response size cap, the tool deadline and cancellation.
 * Errors are the SDK's own error classes, so they are projected and redacted
 * exactly like SDK failures.
 */
export interface DashboardApi {
  me(signal?: AbortSignal): Promise<unknown>;
  listConversations(
    tenantId: string,
    query: ConversationPageQuery,
    signal?: AbortSignal,
  ): Promise<unknown>;
  conversationMessages(
    tenantId: string,
    conversationId: number,
    query: PageQuery,
    signal?: AbortSignal,
  ): Promise<unknown>;
  reply(
    tenantId: string,
    conversationId: number,
    content: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReplyResult>;
  setConversationStatus(
    tenantId: string,
    conversationId: number,
    status: "open" | "resolved",
    signal?: AbortSignal,
  ): Promise<unknown>;
  getCustomerEmail(tenantId: string, signal?: AbortSignal): Promise<unknown>;
  setCustomerEmail(
    tenantId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export const CONVERSATION_STATUS_FILTERS = [
  "open",
  "resolved",
  "pending",
  "snoozed",
  "all",
] as const;
export type ConversationStatusFilter =
  (typeof CONVERSATION_STATUS_FILTERS)[number];

/** A reply plus whether the API answered with its stored original. */
export interface ReplyResult {
  readonly data: unknown;
  /** True when the API sent `idempotent-replayed: true`. */
  readonly replayed: boolean;
}

export interface PageQuery {
  cursor?: string;
  limit?: number;
}
export interface ConversationPageQuery extends PageQuery {
  status?: ConversationStatusFilter;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CURSOR_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,512}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_CODE_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 300;

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  onHeaders?: (headers: Headers) => void;
}

export function createDashboardApi(options: {
  /** The same base URL the SDK client was built with. */
  readonly baseUrl: string;
  readonly token: string;
  /** The executor's bounded transport. */
  readonly fetch: typeof globalThis.fetch;
}): DashboardApi {
  const base = new URL(options.baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const tenantPath = (tenantId: string) => {
    if (!UUID.test(tenantId)) throw invalid("The tenant identifier is invalid");
    return `v1/tenants/${tenantId.toLowerCase()}`;
  };
  const conversationPath = (tenantId: string, conversationId: number) => {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0)
      throw invalid("The conversation identifier is invalid");
    return `${tenantPath(tenantId)}/conversations/${conversationId}`;
  };
  const page = (query: PageQuery) => {
    if (query.cursor !== undefined && !CURSOR_PATTERN.test(query.cursor))
      throw invalid("The page cursor is invalid");
    if (
      query.limit !== undefined &&
      (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    )
      throw invalid("The page size is invalid");
    return {
      cursor: query.cursor,
      limit: query.limit === undefined ? undefined : String(query.limit),
    };
  };

  const request = async (
    path: string,
    request: RequestOptions = {},
  ): Promise<unknown> => {
    const method = request.method ?? "GET";
    const url = new URL(path, base);
    if (!url.href.startsWith(base.href))
      throw invalid("The requested Daykeeper endpoint is not known");
    for (const [name, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(name, value);
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${options.token}`,
    });
    if (request.body !== undefined)
      headers.set("content-type", "application/json");
    if (request.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY.test(request.idempotencyKey))
        throw invalid(
          "The idempotency key must be 16 to 128 URL-safe characters",
        );
      headers.set("idempotency-key", request.idempotencyKey);
    }
    const mutates = method !== "GET";
    let response: Response;
    try {
      response = await options.fetch(url, {
        method,
        headers,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "error",
        credentials: "omit",
        signal: request.signal,
      });
    } catch (error) {
      // The bounded transport throws its own adapter errors (deadline,
      // cancellation, wrong origin, size cap); keep them as they are.
      if (error instanceof McpAdapterError) throw error;
      throw new DaykeeperTransportError({
        code: "NETWORK_ERROR",
        message: "The Daykeeper API could not be reached",
        retryable: !mutates,
        outcomeUnknown: mutates,
      });
    }
    let payload: unknown;
    let unreadable = false;
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      unreadable = true;
    }
    if (!response.ok) {
      const body =
        isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      throw new DaykeeperApiError({
        status: response.status,
        code: bounded(body.code, MAX_CODE_LENGTH) ?? `HTTP_${response.status}`,
        message:
          bounded(body.message, MAX_MESSAGE_LENGTH) ??
          "The Daykeeper API rejected the request",
        retryable:
          response.status === 429 ||
          (typeof body.retryable === "boolean"
            ? body.retryable
            : response.status === 408 || response.status >= 500),
        nextActions: stringList(body.nextActions),
        ...(bounded(body.correlationId, 128)
          ? { correlationId: bounded(body.correlationId, 128) }
          : {}),
        fields: stringList(body.fields),
        // The API may say so itself (409 REQUEST_OUTCOME_UNKNOWN); a 5xx or
        // 408 after dispatch is unknown too.
        outcomeUnknown:
          mutates &&
          (body.outcomeUnknown === true ||
            response.status >= 500 ||
            response.status === 408),
      });
    }
    if (unreadable || !isRecord(payload) || !("data" in payload))
      throw new DaykeeperTransportError({
        code: "INVALID_RESPONSE",
        message: "The Daykeeper API returned an invalid success envelope",
        retryable: !mutates,
        outcomeUnknown: mutates,
      });
    if (request.onHeaders) request.onHeaders(response.headers);
    return payload.data;
  };

  const api: DashboardApi = {
    me: (signal) => request("v1/me", { signal }),
    listConversations: (tenantId, query, signal) => {
      if (
        query.status !== undefined &&
        !(CONVERSATION_STATUS_FILTERS as readonly string[]).includes(
          query.status,
        )
      )
        throw invalid("The conversation status filter is invalid");
      return request(`${tenantPath(tenantId)}/conversations`, {
        query: {
          // The cursor is bound to its status, so the filter is always sent,
          // "all" included.
          status: query.status ?? "open",
          ...page(query),
        },
        signal,
      });
    },
    conversationMessages: (tenantId, conversationId, query, signal) =>
      request(`${conversationPath(tenantId, conversationId)}/messages`, {
        query: page(query),
        signal,
      }),
    reply: async (
      tenantId,
      conversationId,
      content,
      idempotencyKey,
      signal,
    ) => {
      if (
        typeof content !== "string" ||
        !content.trim() ||
        content.length > 4_000
      )
        throw invalid("Replies must contain 1 through 4000 characters");
      let replayed = false;
      const data = await request(
        `${conversationPath(tenantId, conversationId)}/messages`,
        {
          method: "POST",
          body: { content: content.trim() },
          idempotencyKey,
          signal,
          onHeaders: (headers) => {
            replayed =
              headers.get("idempotent-replayed")?.trim().toLowerCase() ===
              "true";
          },
        },
      );
      return { data, replayed };
    },
    setConversationStatus: (tenantId, conversationId, status, signal) => {
      if (status !== "open" && status !== "resolved")
        throw invalid("The conversation status is invalid");
      return request(`${conversationPath(tenantId, conversationId)}/status`, {
        method: "POST",
        body: { status },
        signal,
      });
    },
    getCustomerEmail: (tenantId, signal) =>
      request(`${tenantPath(tenantId)}/customer-email`, { signal }),
    setCustomerEmail: (tenantId, enabled, signal) => {
      if (typeof enabled !== "boolean")
        throw invalid("The customer email setting is invalid");
      return request(`${tenantPath(tenantId)}/customer-email`, {
        method: "POST",
        body: { enabled },
        signal,
      });
    },
  };
  return Object.freeze(api);
}

function invalid(message: string): DaykeeperTransportError {
  return new DaykeeperTransportError({
    code: "INVALID_CONFIGURATION",
    message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, 32)
        .filter((item): item is string => typeof item === "string")
    : [];
}
