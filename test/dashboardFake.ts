import { TENANT } from "./helpers.ts";

export const SECOND_TENANT = "66666666-6666-4666-8666-666666666666";

export interface RecordedCall {
  method: string;
  url: URL;
  authorization: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

export interface FakeApiOptions {
  /** Override one route: return a Response to replace the default answer. */
  override?: (call: RecordedCall) => Response | Promise<Response> | undefined;
}

const tenants = [
  {
    id: TENANT,
    organizationId: "77777777-7777-4777-8777-777777777777",
    spec: { name: "Acme support", slug: "acme", locale: "en" },
    state: "ready",
    version: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
  {
    id: SECOND_TENANT,
    organizationId: "77777777-7777-4777-8777-777777777777",
    spec: { name: "Beta", slug: "beta", locale: "en" },
    state: "provisioning",
    version: 1,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
];

export function conversationItem(id: number, status = "open") {
  return {
    id,
    status,
    preview: `Question ${id}`,
    createdAt: "2026-10-01T10:00:00.000Z",
    lastActivityAt: "2026-10-02T10:00:00.000Z",
  };
}

export function messageItem(
  id: number,
  conversationId: number,
  content = "Hi",
) {
  return {
    id,
    conversationId,
    senderType: "contact",
    messageType: 0,
    content,
    createdAt: "2026-10-02T10:00:00.000Z",
  };
}

const ok = (data: unknown, status = 200) => Response.json({ data }, { status });

/**
 * A minimal Daykeeper `/v1` API: the routes the dashboard tools call, with
 * the response shapes the contract fixes. Every call is recorded.
 */
export function fakeDaykeeperApi(options: FakeApiOptions = {}) {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.body ? await request.text() : "";
    const call: RecordedCall = {
      method: request.method,
      url,
      authorization: request.headers.get("authorization"),
      idempotencyKey: request.headers.get("idempotency-key"),
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const replaced = await options.override?.(call);
    if (replaced) return replaced;
    const path = url.pathname.replace(/^\/proxy/, "");
    const tenant = /^\/v1\/tenants\/([0-9a-f-]{36})/.exec(path)?.[1];
    if (path === "/v1/me")
      return ok({
        userId: "user-123",
        name: "Gabriel",
        email: "gabriel@example.test",
        organizationId: "77777777-7777-4777-8777-777777777777",
        role: "owner",
      });
    if (path === "/v1/tenants") return ok(tenants);
    if (path === "/v1/entitlements")
      return ok({
        organizationId: "77777777-7777-4777-8777-777777777777",
        state: "active",
        assignmentVersion: 1,
        policy: {
          version: "free-2026-08-31",
          plan: "free",
          provisional: true,
          tenantLimit: 1,
        },
        tenantProvisioning: { enforced: true, allowed: false },
        metering: { conversations: "not_enforced", storage: "not_enforced" },
      });
    if (path === "/v1/usage") {
      const counter = (used: number) => ({
        used,
        limit: 1000,
        remaining: 1000 - used,
        limitReached: false,
      });
      return ok({
        organizationId: "77777777-7777-4777-8777-777777777777",
        kind: "resource_safety",
        aggregation: "organization_single_cell",
        asOf: "2026-10-08T00:00:00.000Z",
        period: {
          startsAt: "2026-10-01T00:00:00.000Z",
          endsAt: "2026-11-01T00:00:00.000Z",
          timezone: "UTC",
        },
        state: "active",
        assignmentVersion: 1,
        policy: { version: "free-2026-08-31", provisional: true },
        resources: {
          contactRecords: counter(5),
          conversationRecords: counter(12),
          messageRecords: counter(140),
        },
        writeAdmission: "not_evaluated",
      });
    }
    if (tenant && path === `/v1/tenants/${tenant}/inbox`)
      return ok({
        id: "88888888-8888-4888-8888-888888888888",
        organizationId: "77777777-7777-4777-8777-777777777777",
        tenantId: tenant,
        spec: { type: "api" },
        state: "prepared",
        trafficEnabled: true,
        version: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    if (tenant && path === `/v1/tenants/${tenant}/conversations`)
      return ok({
        tenantId: tenant,
        conversations: [conversationItem(41), conversationItem(40)],
        nextCursor: url.searchParams.get("cursor") ? null : "c2",
      });
    const thread =
      /^\/v1\/tenants\/[0-9a-f-]{36}\/conversations\/(\d+)\/(messages|status)$/.exec(
        path,
      );
    if (thread && thread[2] === "messages" && request.method === "GET")
      return ok({
        tenantId: tenant,
        conversationId: Number(thread[1]),
        messages: [messageItem(1, Number(thread[1]))],
        nextCursor: null,
      });
    if (thread && thread[2] === "messages" && request.method === "POST")
      return ok(
        {
          tenantId: tenant,
          conversationId: Number(thread[1]),
          message: {
            ...messageItem(
              2,
              Number(thread[1]),
              (call.body as { content: string }).content,
            ),
            senderType: "user",
            messageType: 1,
          },
        },
        201,
      );
    if (thread && thread[2] === "status")
      return ok({
        tenantId: tenant,
        conversationId: Number(thread[1]),
        status: (call.body as { status: string }).status,
      });
    if (tenant && path === `/v1/tenants/${tenant}/customer-email`)
      return ok({
        tenantId: tenant,
        enabled:
          request.method === "POST"
            ? (call.body as { enabled: boolean }).enabled
            : true,
        customSender: false,
        senderName: "Acme",
        sendingDomain: "mail.mydaykeeper.com",
        deliveryEnabled: true,
      });
    return Response.json(
      { error: { code: "RESOURCE_NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  };
  return { fetch, calls };
}

export function apiError(status: number, code: string, retryable = false) {
  return Response.json(
    {
      error: {
        code,
        message: "Rejected",
        retryable,
        nextActions: [],
        correlationId: "corr-1",
      },
    },
    { status },
  );
}
