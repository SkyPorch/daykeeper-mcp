import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { validateOptions } from "../src/config.ts";
import { DASHBOARD_TOOL_NAMES } from "../src/dashboard.ts";
import {
  DASHBOARD_WIDGET_HTML,
  DASHBOARD_WIDGET_MIME_TYPE,
  DASHBOARD_WIDGET_URI,
} from "../src/dashboardWidget.ts";
import { toolCatalog } from "../src/tools.ts";
import {
  apiError,
  conversationItem,
  fakeDaykeeperApi,
  SECOND_TENANT,
  type FakeApiOptions,
} from "./dashboardFake.ts";
import { BASE_URL, defaults, harness, TENANT, TOKEN } from "./helpers.ts";

const EXPECTED_TOOLS = [
  "get_profile",
  "list_workspaces",
  "get_dashboard",
  "list_conversations",
  "get_conversation",
  "send_reply",
  "set_conversation_status",
  "get_customer_email",
  "set_customer_email",
  "show_dashboard",
];
const ALL_SCOPES = [
  "daykeeper.accounts:read",
  "daykeeper.accounts:write",
  "daykeeper.billing:read",
  "daykeeper.conversations:read",
  "daykeeper.conversations:write",
];

async function dashboard(
  context: TestContext,
  fake: FakeApiOptions = {},
  scopes: string[] = ALL_SCOPES,
) {
  const api = fakeDaykeeperApi(fake);
  const client = await harness(
    context,
    {
      toolProfile: "dashboard",
      scopes,
      // Every general gate on: the profile must still expose only its ten.
      enablePlanning: true,
      enableMutations: true,
      enableInboxTools: true,
      enableOperatorTools: true,
      enableOperatorWrites: true,
      fetch: api.fetch,
    },
    "modern",
  );
  return { client, calls: api.calls };
}

function data(result: CallToolResult): Record<string, unknown> {
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  assert(!JSON.stringify(result).includes(TOKEN));
  return result.structuredContent as Record<string, unknown>;
}

function failure(result: CallToolResult) {
  assert.equal(result.isError, true);
  assert(!JSON.stringify(result).includes(TOKEN));
  return (result.structuredContent as { error: Record<string, unknown> }).error;
}

test("the dashboard profile exposes exactly the ten dashboard tools and nothing else", async (context) => {
  const { client } = await dashboard(context);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );
  assert.deepEqual(
    [...DASHBOARD_TOOL_NAMES].sort(),
    [...EXPECTED_TOOLS].sort(),
  );
  for (const tool of tools) {
    assert(tool.description && tool.description.length <= 400, tool.name);
    assert(tool.outputSchema, `${tool.name} has an output schema`);
    assert.equal(tool.inputSchema.type, "object");
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const readOnly = [
    "get_profile",
    "list_workspaces",
    "get_dashboard",
    "list_conversations",
    "get_conversation",
    "get_customer_email",
    "show_dashboard",
  ];
  for (const name of readOnly)
    assert.deepEqual(
      [
        byName[name]!.annotations?.readOnlyHint,
        byName[name]!.annotations?.destructiveHint,
        byName[name]!.annotations?.openWorldHint,
      ],
      [true, false, false],
      name,
    );
  // Sending a message to a customer cannot be undone and leaves the account.
  assert.equal(byName.send_reply!.annotations?.readOnlyHint, false);
  assert.equal(byName.send_reply!.annotations?.destructiveHint, true);
  assert.equal(byName.send_reply!.annotations?.openWorldHint, true);
  assert.equal(byName.send_reply!.annotations?.idempotentHint, false);
  assert.match(
    byName.send_reply!.description ?? "",
    /sends? .*now|immediately/i,
  );
  for (const name of ["set_conversation_status", "set_customer_email"]) {
    assert.equal(byName[name]!.annotations?.readOnlyHint, false);
    assert.equal(byName[name]!.annotations?.destructiveHint, false);
    assert.equal(byName[name]!.annotations?.openWorldHint, false);
  }
  // Drafting is the model's job, never a tool.
  assert(!tools.some((tool) => /draft/i.test(tool.name)));
  // The profile tool is designated with the documented marker and schema.
  assert.equal(byName.get_profile!._meta?.["openai/profile"], true);
  assert.deepEqual(byName.get_profile!.outputSchema?.required, ["id"]);
  assert.equal(byName.get_profile!.outputSchema?.additionalProperties, false);
});

test("only show_dashboard attaches the UI resource; widget actions are app-callable", async (context) => {
  const { client } = await dashboard(context);
  const tools = (await client.listTools()).tools;
  const withTemplate = tools.filter(
    (tool) =>
      (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri ||
      tool._meta?.["openai/outputTemplate"],
  );
  assert.deepEqual(
    withTemplate.map((tool) => tool.name),
    ["show_dashboard"],
  );
  const show = withTemplate[0]!;
  assert.equal(
    (show._meta?.ui as { resourceUri: string }).resourceUri,
    DASHBOARD_WIDGET_URI,
  );
  assert.equal(show._meta?.["openai/outputTemplate"], DASHBOARD_WIDGET_URI);
  for (const name of [
    "get_dashboard",
    "list_conversations",
    "get_conversation",
    "send_reply",
    "set_conversation_status",
    "get_customer_email",
    "set_customer_email",
  ]) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    assert.equal(tool._meta?.["openai/widgetAccessible"], true, name);
    assert.deepEqual((tool._meta?.ui as { visibility: string[] }).visibility, [
      "model",
      "app",
    ]);
  }
  const resources = (await client.listResources()).resources;
  const widget = resources.find((item) => item.uri === DASHBOARD_WIDGET_URI);
  assert(widget);
  assert.equal(widget.mimeType, DASHBOARD_WIDGET_MIME_TYPE);
  const read = await client.readResource({ uri: DASHBOARD_WIDGET_URI });
  const content = read.contents[0]!;
  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  assert("text" in content);
  assert.equal(content.text, DASHBOARD_WIDGET_HTML);
  const ui = (content._meta as { ui: Record<string, unknown> }).ui;
  assert.deepEqual(ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.equal(ui.prefersBorder, true);
});

test("the widget is self-contained, credential-free and uses the MCP Apps bridge", () => {
  const html = DASHBOARD_WIDGET_HTML;
  // No external network: no remote scripts, styles, images, frames or fetch.
  assert(!/<script[^>]+src=/i.test(html));
  assert(!/<link[^>]+href=/i.test(html));
  assert(
    !/https?:\/\//i.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, "")),
  );
  assert(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|<iframe/i.test(html));
  assert(!/innerHTML/.test(html));
  assert(!/authorization|bearer|token/i.test(html));
  for (const method of [
    "ui/initialize",
    "ui/notifications/initialized",
    "ui/notifications/tool-result",
    "tools/call",
    "ui/notifications/size-changed",
  ])
    assert(html.includes(method), method);
  for (const label of [
    ">Daykeeper<",
    ">Refresh<",
    ">Inbox<",
    ">Usage<",
    ">Settings<",
    "Inbox status",
    "Plan",
    ">Send<",
    "Resolve",
    "Reopen",
    "Customer email",
    ">Back<",
  ])
    assert(html.includes(label), label);
  // Widget buttons call the same tools the model uses.
  for (const name of [
    "get_dashboard",
    "list_conversations",
    "get_conversation",
    "send_reply",
    "set_conversation_status",
    "get_customer_email",
    "set_customer_email",
  ])
    assert(html.includes(`"${name}"`), name);
  assert.match(html, /@media \(max-width:640px\)/);
});

test("the general profile never exposes dashboard tools or the widget", async (context) => {
  const client = await harness(context, {
    enableOperatorTools: true,
    enableOperatorWrites: true,
    enableMutations: true,
    scopes: ALL_SCOPES,
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of EXPECTED_TOOLS) assert(!names.includes(name), name);
  const resources = (await client.listResources()).resources;
  assert(!resources.some((item) => item.uri === DASHBOARD_WIDGET_URI));
  const general = toolCatalog(validateOptions(defaults));
  assert(!general.some((tool) => EXPECTED_TOOLS.includes(tool.name)));
  assert.throws(
    () =>
      validateOptions({
        ...defaults,
        toolProfile: "admin" as unknown as "dashboard",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
  assert.throws(
    () =>
      validateOptions({
        ...defaults,
        dashboardWidgetDomain: "https://widgets.example.test",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
});

test("get_profile returns an opaque, stable id plus display fields only", async (context) => {
  const { client, calls } = await dashboard(context);
  const first = data(
    await client.callTool({ name: "get_profile", arguments: {} }),
  );
  const second = data(
    await client.callTool({ name: "get_profile", arguments: {} }),
  );
  assert.deepEqual(Object.keys(first).sort(), ["email", "id", "name"]);
  assert.match(String(first.id), /^dkp_[A-Za-z0-9_-]{32}$/);
  assert.equal(first.id, second.id);
  assert(!String(first.id).includes("user-123"));
  assert.equal(first.email, "gabriel@example.test");
  assert.equal(calls[0]!.url.pathname, "/proxy/v1/me");
  assert.equal(calls[0]!.authorization, `Bearer ${TOKEN}`);
});

test("list_workspaces projects tenants without provider or organization detail", async (context) => {
  const { client } = await dashboard(context);
  const result = data(
    await client.callTool({ name: "list_workspaces", arguments: {} }),
  );
  assert.deepEqual(result, {
    workspaces: [
      { id: TENANT, name: "Acme support", slug: "acme", state: "ready" },
      { id: SECOND_TENANT, name: "Beta", slug: "beta", state: "provisioning" },
    ],
  });
});

test("get_dashboard composes plan, usage, inbox and the first open page", async (context) => {
  const { client, calls } = await dashboard(context);
  const result = data(
    await client.callTool({ name: "get_dashboard", arguments: {} }),
  );
  assert.equal(result.workspaceId, TENANT);
  assert.deepEqual(result.plan, {
    name: "free",
    state: "active",
    workspaceLimit: 1,
  });
  assert.deepEqual(result.inbox, { state: "prepared", trafficEnabled: true });
  assert.deepEqual((result.usage as { conversations: unknown }).conversations, {
    used: 12,
    limit: 1000,
  });
  const page = result.inboxConversations as Record<string, unknown>;
  assert.equal(page.status, "open");
  assert.equal(page.showing, 2);
  assert.equal(page.more, true);
  assert.equal(page.nextCursor, "c2.open");
  assert.equal(page.summary, "Showing 2, more available.");
  assert.deepEqual(result.unavailable, []);
  const list = calls.find((call) =>
    call.url.pathname.endsWith("/conversations"),
  )!;
  assert.equal(list.url.searchParams.get("status"), "open");
  assert.equal(list.url.searchParams.get("limit"), "20");
  // A chosen workspace must be one this connection can see.
  const missing = failure(
    await client.callTool({
      name: "get_dashboard",
      arguments: { workspaceId: "99999999-9999-4999-8999-999999999999" },
    }),
  );
  assert.equal(missing.code, "WORKSPACE_NOT_FOUND");
});

test("get_dashboard omits sections the API refuses with 403 or 503 instead of failing", async (context) => {
  const { client } = await dashboard(context, {
    override: (call) => {
      if (call.url.pathname.endsWith("/v1/usage"))
        return apiError(403, "SCOPE_REQUIRED");
      if (call.url.pathname.endsWith("/v1/entitlements"))
        return apiError(503, "SERVICE_UNAVAILABLE", true);
      if (call.url.pathname.endsWith("/conversations"))
        return apiError(403, "SCOPE_REQUIRED");
      return undefined;
    },
  });
  const result = data(
    await client.callTool({
      name: "get_dashboard",
      arguments: { workspaceId: SECOND_TENANT },
    }),
  );
  assert.equal(result.workspaceId, SECOND_TENANT);
  assert.equal(result.plan, undefined);
  assert.equal(result.usage, undefined);
  assert.equal(result.inboxConversations, undefined);
  assert.deepEqual(result.unavailable, ["conversations", "plan", "usage"]);
  assert(result.inbox);
});

test("get_dashboard still fails on other errors rather than hiding them", async (context) => {
  const { client } = await dashboard(context, {
    override: (call) =>
      call.url.pathname.endsWith("/v1/usage")
        ? apiError(500, "INTERNAL", true)
        : undefined,
  });
  const error = failure(
    await client.callTool({ name: "get_dashboard", arguments: {} }),
  );
  assert.equal(error.status, 500);
});

test("list_conversations pages by cursor and never claims a total", async (context) => {
  const { client, calls } = await dashboard(context);
  const first = data(
    await client.callTool({
      name: "list_conversations",
      arguments: { workspaceId: TENANT, status: "resolved", limit: 2 },
    }),
  );
  assert.equal(first.summary, "Showing 2, more available.");
  assert.equal(first.more, true);
  assert.equal(first.nextCursor, "c2.resolved");
  assert(!("total" in first));
  const second = data(
    await client.callTool({
      name: "list_conversations",
      arguments: {
        workspaceId: TENANT,
        status: "resolved",
        cursor: "c2.resolved",
      },
    }),
  );
  assert.equal(second.summary, "Showing 2.");
  assert.equal(second.more, false);
  assert.equal(second.nextCursor, null);
  assert.equal(calls[0]!.url.searchParams.get("status"), "resolved");
  assert.equal(calls[0]!.url.searchParams.get("limit"), "2");
  assert.equal(calls[1]!.url.searchParams.get("cursor"), "c2.resolved");
  const bad = await client.callTool({
    name: "list_conversations",
    arguments: { workspaceId: TENANT, cursor: "bad cursor" },
  });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 2);
});

test("list_conversations sends every status filter explicitly, all included", async (context) => {
  const { client, calls } = await dashboard(context);
  for (const status of ["open", "resolved", "pending", "snoozed", "all"]) {
    const result = data(
      await client.callTool({
        name: "list_conversations",
        arguments: { workspaceId: TENANT, status },
      }),
    );
    assert.equal(result.status, status);
  }
  data(
    await client.callTool({
      name: "list_conversations",
      arguments: { workspaceId: TENANT },
    }),
  );
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("status")),
    ["open", "resolved", "pending", "snoozed", "all", "open"],
  );
  const invalid = await client.callTool({
    name: "list_conversations",
    arguments: { workspaceId: TENANT, status: "closed" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 6);
  // A cursor from another status is the API's call to refuse.
  const crossed = failure(
    await client.callTool({
      name: "list_conversations",
      arguments: { workspaceId: TENANT, status: "all", cursor: "c2.open" },
    }),
  );
  assert.equal(crossed.code, "INVALID_CURSOR");
});

test("get_conversation reads one page of messages", async (context) => {
  const { client, calls } = await dashboard(context);
  const result = data(
    await client.callTool({
      name: "get_conversation",
      arguments: { workspaceId: TENANT, conversationId: 41, cursor: "m2" },
    }),
  );
  assert.equal(result.conversationId, 41);
  assert.equal((result.messages as unknown[]).length, 1);
  assert.equal(result.summary, "Showing 1.");
  assert.equal(
    calls[0]!.url.pathname,
    `/proxy/v1/tenants/${TENANT}/conversations/41/messages`,
  );
  assert.equal(calls[0]!.url.searchParams.get("cursor"), "m2");
});

test("send_reply sends immediately with a generated idempotency key it returns", async (context) => {
  const { client, calls } = await dashboard(context);
  const result = data(
    await client.callTool({
      name: "send_reply",
      arguments: {
        workspaceId: TENANT,
        conversationId: 41,
        content: " Thanks! ",
      },
    }),
  );
  assert.equal(result.sent, true);
  assert.match(
    String(result.idempotencyKey),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.idempotencyKey, result.idempotencyKey);
  assert.deepEqual(calls[0]!.body, { content: "Thanks!" });
  // A host-supplied key is used as-is, so a retry can reuse it.
  const key = "reply-retry-key-000000000001";
  const retried = data(
    await client.callTool({
      name: "send_reply",
      arguments: {
        workspaceId: TENANT,
        conversationId: 41,
        content: "Thanks!",
        idempotencyKey: key,
      },
    }),
  );
  assert.equal(retried.idempotencyKey, key);
  assert.equal(calls[1]!.idempotencyKey, key);
});

test("send_reply surfaces an unknown outcome with its key and never retries", async (context) => {
  for (const fail of [
    () => apiError(502, "UPSTREAM_UNAVAILABLE", true),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    let attempts = 0;
    const { client } = await dashboard(context, {
      override: (call) => {
        if (call.method !== "POST") return undefined;
        attempts++;
        return fail();
      },
    });
    const error = failure(
      await client.callTool({
        name: "send_reply",
        arguments: { workspaceId: TENANT, conversationId: 41, content: "Hi" },
      }),
    );
    assert.equal(attempts, 1);
    assert.equal(error.outcome, "unknown");
    assert.equal(error.retryable, false);
    assert.match(String(error.idempotencyKey), /^[0-9a-f-]{36}$/);
    assert.match(String(error.message), /may already have been sent/);
    assert(String(error.message).includes(String(error.idempotencyKey)));
    assert(
      (error.nextActions as string[]).includes(
        "reuse_original_idempotency_key",
      ),
    );
  }
});

test("a definite refusal of send_reply is not reported as unknown", async (context) => {
  const { client } = await dashboard(context, {
    override: (call) =>
      call.method === "POST"
        ? apiError(409, "REQUEST_IN_PROGRESS", true)
        : undefined,
  });
  const error = failure(
    await client.callTool({
      name: "send_reply",
      arguments: { workspaceId: TENANT, conversationId: 41, content: "Hi" },
    }),
  );
  assert.equal(error.code, "REQUEST_IN_PROGRESS");
  assert.equal(error.outcome, undefined);
  assert.equal(error.status, 409);
});

test("dashboard writes are refused locally when the connection lacks the scope", async (context) => {
  const { client, calls } = await dashboard(context, {}, [
    "daykeeper.accounts:read",
    "daykeeper.conversations:read",
  ]);
  for (const [name, args] of [
    ["send_reply", { workspaceId: TENANT, conversationId: 41, content: "Hi" }],
    [
      "set_conversation_status",
      { workspaceId: TENANT, conversationId: 41, status: "resolved" },
    ],
    ["set_customer_email", { workspaceId: TENANT, enabled: false }],
  ] as const) {
    const error = failure(await client.callTool({ name, arguments: args }));
    assert.equal(error.code, "SCOPE_NOT_GRANTED", name);
  }
  assert.equal(calls.length, 0);
});

test("set_conversation_status resolves and reopens", async (context) => {
  const { client, calls } = await dashboard(context);
  for (const status of ["resolved", "open"] as const) {
    const result = data(
      await client.callTool({
        name: "set_conversation_status",
        arguments: { workspaceId: TENANT, conversationId: 41, status },
      }),
    );
    assert.deepEqual(result, {
      workspaceId: TENANT,
      conversationId: 41,
      status,
    });
  }
  assert.equal(
    calls[0]!.url.pathname,
    `/proxy/v1/tenants/${TENANT}/conversations/41/status`,
  );
  assert.deepEqual(calls[0]!.body, { status: "resolved" });
  const invalid = await client.callTool({
    name: "set_conversation_status",
    arguments: { workspaceId: TENANT, conversationId: 41, status: "snoozed" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 2);
});

test("customer email reads and switches the workspace setting", async (context) => {
  const { client, calls } = await dashboard(context);
  const current = data(
    await client.callTool({
      name: "get_customer_email",
      arguments: { workspaceId: TENANT },
    }),
  );
  assert.equal(current.enabled, true);
  assert.equal(current.workspaceId, TENANT);
  assert(!("tenantId" in current));
  const changed = data(
    await client.callTool({
      name: "set_customer_email",
      arguments: { workspaceId: TENANT, enabled: false },
    }),
  );
  assert.equal(changed.enabled, false);
  assert.equal(calls[1]!.method, "POST");
  assert.deepEqual(calls[1]!.body, { enabled: false });
  assert.equal(
    calls[1]!.url.pathname,
    `/proxy/v1/tenants/${TENANT}/customer-email`,
  );
});

test("show_dashboard returns the same dashboard data for the UI to render", async (context) => {
  const { client } = await dashboard(context);
  const result = data(
    await client.callTool({ name: "show_dashboard", arguments: {} }),
  );
  assert.equal(result.workspaceId, TENANT);
  assert(Array.isArray(result.workspaces));
  assert(result.inboxConversations);
});

test("malformed API data is refused rather than passed through", async (context) => {
  const { client } = await dashboard(context, {
    override: (call) =>
      call.url.pathname.endsWith("/conversations")
        ? Response.json({
            data: {
              conversations: [{ ...conversationItem(1), id: "one" }],
            },
          })
        : undefined,
  });
  const error = failure(
    await client.callTool({
      name: "list_conversations",
      arguments: { workspaceId: TENANT },
    }),
  );
  assert.equal(error.code, "INVALID_API_RESPONSE");
});

test("dashboard calls never follow a redirect", async (context) => {
  const { client, calls } = await dashboard(context, {
    override: () => Response.redirect("https://elsewhere.example.test/", 302),
  });
  const error = failure(
    await client.callTool({ name: "get_profile", arguments: {} }),
  );
  assert.equal(error.status, 302);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.origin, new URL(BASE_URL).origin);
});

test("send_reply reports a replayed answer from the idempotent-replayed header", async (context) => {
  const { client, calls } = await dashboard(context);
  const key = "reply-replay-key-0000000000001";
  const args = {
    workspaceId: TENANT,
    conversationId: 41,
    content: "Thanks!",
    idempotencyKey: key,
  };
  const first = data(
    await client.callTool({ name: "send_reply", arguments: args }),
  );
  assert.equal(first.replayed, false);
  const again = data(
    await client.callTool({ name: "send_reply", arguments: args }),
  );
  assert.equal(again.replayed, true);
  assert.deepEqual(again.message, first.message);
  assert.equal(calls.length, 2);
});

test("send_reply explains in-progress, unknown-outcome and reused-key refusals", async (context) => {
  const cases: Array<[Response, (error: Record<string, unknown>) => void]> = [
    [
      apiError(409, "REQUEST_IN_PROGRESS", true),
      (error) => {
        assert.equal(error.outcome, undefined);
        assert.equal(error.status, 409);
        assert.match(String(error.message), /still being processed/);
        assert.match(String(error.message), /same key/);
      },
    ],
    [
      apiError(409, "REQUEST_OUTCOME_UNKNOWN", false, { outcomeUnknown: true }),
      (error) => {
        assert.equal(error.outcome, "unknown");
        assert.equal(error.retryable, false);
        assert.match(String(error.message), /may already have been sent/);
        assert(
          (error.nextActions as string[]).includes(
            "reuse_original_idempotency_key",
          ),
        );
      },
    ],
    [
      apiError(422, "IDEMPOTENCY_KEY_REUSED"),
      (error) => {
        assert.equal(error.outcome, undefined);
        assert.equal(error.status, 422);
        assert.match(
          String(error.message),
          /already used for a different reply/,
        );
        assert(
          (error.nextActions as string[]).includes(
            "use_a_fresh_key_only_for_a_different_request",
          ),
        );
      },
    ],
  ];
  for (const [answer, check] of cases) {
    let attempts = 0;
    const { client } = await dashboard(context, {
      override: (call) => {
        if (call.method !== "POST") return undefined;
        attempts++;
        return answer.clone();
      },
    });
    const key = "reply-refusal-key-00000000001";
    const error = failure(
      await client.callTool({
        name: "send_reply",
        arguments: {
          workspaceId: TENANT,
          conversationId: 41,
          content: "Hi",
          idempotencyKey: key,
        },
      }),
    );
    assert.equal(attempts, 1);
    assert.equal(error.idempotencyKey, key);
    check(error);
  }
});

test("set_conversation_status checks the API echoes the same conversation", async (context) => {
  const { client } = await dashboard(context, {
    override: (call) =>
      call.url.pathname.endsWith("/status")
        ? Response.json({
            data: { tenantId: TENANT, conversationId: 99, status: "resolved" },
          })
        : undefined,
  });
  const error = failure(
    await client.callTool({
      name: "set_conversation_status",
      arguments: {
        workspaceId: TENANT,
        conversationId: 41,
        status: "resolved",
      },
    }),
  );
  assert.equal(error.code, "INVALID_API_RESPONSE");
});

test("a 401 from the API carries the reconnect challenge only when the resource is known", async (context) => {
  const metadata =
    "https://api.mydaykeeper.com/.well-known/oauth-protected-resource/mcp";
  const revoked = () => apiError(401, "UNAUTHENTICATED");
  for (const resourceMetadataUrl of [metadata, undefined]) {
    const api = fakeDaykeeperApi({ override: revoked });
    const client = await harness(
      context,
      {
        toolProfile: "dashboard",
        scopes: ALL_SCOPES,
        fetch: api.fetch,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      },
      "modern",
    );
    for (const [name, args] of [
      ["get_profile", {}],
      [
        "send_reply",
        { workspaceId: TENANT, conversationId: 41, content: "Hi" },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const error = failure(result);
      assert.equal(error.status, 401);
      assert.match(String(error.message), /Reconnect Daykeeper/);
      const challenge = result._meta?.["mcp/www_authenticate"];
      if (!resourceMetadataUrl) {
        assert.equal(challenge, undefined);
        continue;
      }
      assert(Array.isArray(challenge) && challenge.length === 1);
      assert.equal(
        challenge[0],
        `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="Your Daykeeper connection has expired or was revoked. Reconnect Daykeeper to continue."`,
      );
    }
  }
  // A 403 is a permission answer, not a reason to reconnect.
  const api = fakeDaykeeperApi({
    override: () => apiError(403, "FORBIDDEN"),
  });
  const client = await harness(
    context,
    {
      toolProfile: "dashboard",
      scopes: ALL_SCOPES,
      fetch: api.fetch,
      resourceMetadataUrl: metadata,
    },
    "modern",
  );
  const forbidden = await client.callTool({
    name: "get_profile",
    arguments: {},
  });
  assert.equal(forbidden.isError, true);
  assert.equal(forbidden._meta?.["mcp/www_authenticate"], undefined);
});
