import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDashboardMcpServer } from "../src/dashboardServer.ts";
import { BASE_URL, api } from "./helpers.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

test("dashboard reply uses the connection-bound ready API tenant and required stable UUID", async (context) => {
  const requests: Array<{
    method: string;
    url: string;
    idempotencyKey: string | null;
    body?: unknown;
  }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      url: `${url.pathname}${url.search}`,
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      ...(body ? { body } : {}),
    });
    if (url.pathname === "/proxy/v1/tenants" && method === "GET")
      return api([
        {
          id: "99999999-9999-4999-8999-999999999999",
          state: "ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          spec: { inbox: { type: "website" } },
        },
        {
          id: tenantId,
          state: "ready",
          createdAt: "2026-02-01T00:00:00.000Z",
          spec: { inbox: { type: "api" } },
        },
      ]);
    if (
      url.pathname ===
        `/proxy/v1/tenants/${tenantId}/conversations/47/messages` &&
      method === "POST"
    )
      return api(
        {
          tenantId,
          conversationId: 47,
          message: {
            id: 700,
            conversationId: 47,
            senderType: "agent",
            messageType: 1,
            content: "Thanks for the details.",
            createdAt: "2026-10-08T00:00:00.000Z",
          },
        },
        201,
      );
    throw new Error("Unexpected dashboard API request");
  };
  const principal = {
    principalId: "user-1:organization-1",
    grantId: "connection-1",
    downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 120,
    daykeeper: {
      baseUrl: BASE_URL,
      accessToken: "daykeeper-exchanged-api-token-123456789",
      timeoutMs: 5_000,
      enableMutations: true,
      enableOperatorTools: true,
      enableOperatorWrites: true,
      scopes: ["daykeeper.accounts:read", "daykeeper.conversations:write"],
      fetch,
    },
  } as const;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () =>
      createDashboardMcpServer(
        principal,
        {
          transport: "streamable_http",
          hostedOAuth: true,
          http: {
            maximumConcurrentRequests: 32,
            maximumConcurrentAuthentications: 64,
            maximumConcurrentRequestsPerPrincipal: 4,
            maximumRequestBytes: 1_048_576,
            maximumResponseBytes: 1_572_864,
            requestReadTimeoutMs: 10_000,
            responseReadTimeoutMs: 65_000,
            authenticationTimeoutMs: 5_000,
          },
        },
        "<html><body>dashboard</body></html>",
        "https://dashboard.example.test/.well-known/oauth-protected-resource/mcp",
      ),
    { transport: serverTransport, legacy: "serve", maxSubscriptions: 0 },
  );
  const client = new Client({ name: "dashboard-test", version: "0.0.0" });
  context.after(async () => {
    await client.close();
    await handle.close();
  });
  await client.connect(clientTransport, { timeout: 3_000 });

  const result = await client.callTool({
    name: "send_reply",
    arguments: {
      conversationId: 47,
      body: "Thanks for the details.",
      requestId,
    },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { sent: true });
  assert.deepEqual(requests, [
    { method: "GET", url: "/proxy/v1/tenants", idempotencyKey: null },
    {
      method: "POST",
      url: `/proxy/v1/tenants/${tenantId}/conversations/47/messages`,
      idempotencyKey: requestId,
      body: { content: "Thanks for the details." },
    },
  ]);

  const widened = await client.callTool({
    name: "list_conversations",
    arguments: { tenantId, limit: 10 },
  });
  assert.equal(widened.isError, true);
  assert.equal(requests.length, 2);
});

test("dashboard reads and mutations normalize their main-use contract, and only show_dashboard declares the UI resource", async (context) => {
  const requests: Array<{ method: string; path: string }> = [];
  let rejectProfile = false;
  let rejectEmailScope = false;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/proxy/, "");
    requests.push({ method, path });
    if (path === "/v1/profile" && rejectProfile)
      return Response.json(
        { error: { code: "AUTHENTICATION_REQUIRED", message: "expired" } },
        { status: 401 },
      );
    if (path === "/v1/profile")
      return api({
        userId: "33333333-3333-4333-8333-333333333333",
        name: "Alex",
        email: "alex@example.test",
        organizationId: "44444444-4444-4444-8444-444444444444",
        workspace: {
          organizationId: "44444444-4444-4444-8444-444444444444",
          organizationSlug: "acme",
          name: "Acme",
        },
      });
    if (path === "/v1/workspaces")
      return api({
        items: [
          {
            organizationId: "44444444-4444-4444-8444-444444444444",
            organizationSlug: "acme",
            name: "Acme",
            role: "owner",
          },
        ],
      });
    if (path === "/v1/tenants")
      return api([
        {
          id: tenantId,
          state: "ready",
          createdAt: "2026-02-01T00:00:00.000Z",
          spec: { inbox: { type: "api" } },
        },
      ]);
    if (path === "/v1/entitlements") return api({ policy: { plan: "pro" } });
    if (path === "/v1/usage")
      return api({
        period: {
          startsAt: "2026-10-01T00:00:00.000Z",
          endsAt: "2026-11-01T00:00:00.000Z",
        },
        resources: { conversationRecords: { used: 7, limit: 100 } },
      });
    if (path === `/v1/tenants/${tenantId}/inbox`)
      return api({ trafficEnabled: true });
    if (path === `/v1/tenants/${tenantId}/conversations/47` && method === "GET")
      return api({
        tenantId,
        conversationId: 47,
        conversation: { id: 47, status: "open", preview: "Need help" },
      });
    if (
      path === `/v1/tenants/${tenantId}/conversations/47/messages` &&
      method === "GET"
    )
      return api({
        tenantId,
        conversationId: 47,
        messages: [
          {
            id: 700,
            conversationId: 47,
            senderType: "Contact",
            messageType: 0,
            content: "Need help",
            createdAt: "2026-10-08T00:00:00.000Z",
          },
        ],
        page: { limit: 50, nextCursor: "older-cursor", hasMore: true },
      });
    if (
      path === `/v1/tenants/${tenantId}/conversations/47` &&
      method === "PATCH"
    )
      return api({
        tenantId,
        conversationId: 47,
        conversation: { id: 47, status: "resolved", preview: "Need help" },
      });
    if (path === `/v1/tenants/${tenantId}/customer-email` && rejectEmailScope)
      return Response.json(
        { error: { code: "SCOPE_REQUIRED", message: "scope missing" } },
        { status: 403 },
      );
    if (path === `/v1/tenants/${tenantId}/customer-email`)
      return api({ tenantId, enabled: method === "POST" });
    throw new Error(`Unexpected dashboard API request: ${method} ${path}`);
  };
  const principal = {
    principalId: "user-1:organization-1",
    grantId: "connection-1",
    downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 120,
    daykeeper: {
      baseUrl: BASE_URL,
      accessToken: "daykeeper-exchanged-api-token-123456789",
      timeoutMs: 5_000,
      enableMutations: true,
      enableOperatorTools: true,
      enableOperatorWrites: true,
      scopes: [
        "daykeeper.accounts:read",
        "daykeeper.accounts:write",
        "daykeeper.billing:read",
        "daykeeper.conversations:read",
        "daykeeper.conversations:write",
      ],
      fetch,
    },
  } as const;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const wireResponses: unknown[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message) => {
    if (
      message &&
      typeof message === "object" &&
      "result" in message &&
      message.result &&
      typeof message.result === "object" &&
      "tools" in message.result
    )
      wireResponses.push(message);
    await send(message);
  };
  const handle = serveStdio(
    () =>
      createDashboardMcpServer(
        principal,
        {
          transport: "streamable_http",
          hostedOAuth: true,
          http: {
            maximumConcurrentRequests: 32,
            maximumConcurrentAuthentications: 64,
            maximumConcurrentRequestsPerPrincipal: 4,
            maximumRequestBytes: 1_048_576,
            maximumResponseBytes: 1_572_864,
            requestReadTimeoutMs: 10_000,
            responseReadTimeoutMs: 65_000,
            authenticationTimeoutMs: 5_000,
          },
        },
        "<!doctype html><html><body>dashboard</body></html>",
        "https://dashboard.example.test/.well-known/oauth-protected-resource/mcp",
      ),
    { transport: serverTransport, legacy: "serve", maxSubscriptions: 0 },
  );
  const client = new Client({
    name: "dashboard-contract-test",
    version: "0.0.0",
  });
  context.after(async () => {
    await client.close();
    await handle.close();
  });
  await client.connect(clientTransport, { timeout: 3_000 });

  const { tools } = await client.listTools();
  const wireToolList = wireResponses.find((message) => {
    const result = (message as { result?: { tools?: unknown } }).result;
    return Array.isArray(result?.tools);
  }) as { result: { tools: Array<Record<string, unknown>> } } | undefined;
  assert.ok(wireToolList, "tools/list response must be captured on the wire");
  assert.equal(wireToolList.result.tools.length, 10);
  const resourceUri = "ui://daykeeper-dashboard/dashboard.html";
  const expectedScopes: Record<string, string[]> = {
    get_profile: ["daykeeper.accounts:read"],
    list_workspaces: ["daykeeper.accounts:read"],
    get_dashboard: ["daykeeper.accounts:read", "daykeeper.billing:read"],
    list_conversations: [
      "daykeeper.accounts:read",
      "daykeeper.conversations:read",
    ],
    get_conversation: [
      "daykeeper.accounts:read",
      "daykeeper.conversations:read",
    ],
    send_reply: ["daykeeper.accounts:read", "daykeeper.conversations:write"],
    set_conversation_status: [
      "daykeeper.accounts:read",
      "daykeeper.conversations:write",
    ],
    get_customer_email: ["daykeeper.accounts:read"],
    set_customer_email: ["daykeeper.accounts:read", "daykeeper.accounts:write"],
    show_dashboard: ["daykeeper.accounts:read"],
  };
  const wireToolsByName = new Map(
    wireToolList.result.tools.map((tool) => [String(tool.name), tool]),
  );
  assert.deepEqual(
    [...wireToolsByName.keys()].sort(),
    Object.keys(expectedScopes).sort(),
  );
  for (const [name, tool] of wireToolsByName) {
    assert.deepEqual(
      tool.securitySchemes,
      name === "get_profile"
        ? [{ type: "noauth" }, { type: "oauth2", scopes: expectedScopes[name] }]
        : [{ type: "oauth2", scopes: expectedScopes[name] }],
    );
    const meta = tool._meta as
      { securitySchemes?: unknown; ui?: { resourceUri?: string } } | undefined;
    assert.deepEqual(meta?.securitySchemes, tool.securitySchemes);
    assert.equal(
      meta?.ui?.resourceUri,
      name === "show_dashboard" ? resourceUri : undefined,
    );
  }
  for (const tool of tools) {
    const meta = (
      tool as unknown as {
        _meta?: {
          securitySchemes?: Array<{ type: string; scopes?: string[] }>;
          ui?: { resourceUri?: string };
        };
      }
    )._meta;
    const wireTool = wireToolsByName.get(tool.name)!;
    const expected =
      tool.name === "get_profile"
        ? [
            { type: "noauth" },
            { type: "oauth2", scopes: expectedScopes[tool.name] },
          ]
        : [{ type: "oauth2", scopes: expectedScopes[tool.name] }];
    assert.deepEqual(
      meta?.securitySchemes,
      expected,
      `${tool.name} compatibility policy`,
    );
    assert.deepEqual(wireTool.securitySchemes, expected);
    assert.equal(
      meta?.ui?.resourceUri,
      tool.name === "show_dashboard" ? resourceUri : undefined,
    );
  }

  const profile = await client.callTool({ name: "get_profile", arguments: {} });
  assert.notEqual(profile.isError, true);
  assert.deepEqual(profile.structuredContent, {
    userId: "33333333-3333-4333-8333-333333333333",
    name: "Alex",
    email: "alex@example.test",
    workspaceId: "44444444-4444-4444-8444-444444444444",
    workspaceName: "Acme",
    workspace: { id: "44444444-4444-4444-8444-444444444444", name: "Acme" },
  });

  rejectProfile = true;
  const unauthorized = await client.callTool({
    name: "get_profile",
    arguments: {},
  });
  rejectProfile = false;
  assert.equal(unauthorized.isError, true);
  const challenge = (
    unauthorized as unknown as {
      _meta?: { "mcp/www_authenticate"?: string[] };
    }
  )._meta?.["mcp/www_authenticate"];
  assert.equal(challenge?.length, 1);
  assert.match(
    challenge?.[0] ?? "",
    /resource_metadata="https:\/\/dashboard\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  assert.match(challenge?.[0] ?? "", /error="invalid_token"/);
  assert.match(challenge?.[0] ?? "", /error_description="[^"]+"/);
  assert.match(
    challenge?.[0] ?? "",
    /Create your Daykeeper account or connect an existing account to continue/,
  );
  assert.equal(
    unauthorized.content?.[0]?.type === "text"
      ? unauthorized.content[0].text
      : "",
    "Create your Daykeeper account or connect an existing account to continue.",
  );
  const challengeDescription =
    /error_description="([^"]+)"/.exec(challenge?.[0] ?? "")?.[1] ?? "";
  assert.doesNotMatch(challengeDescription, /https?:\/\//i);
  assert.doesNotMatch(challenge?.[0] ?? "", /Codex/i);
  assert.doesNotMatch(challenge?.[0] ?? "", /daykeeper-exchanged-api-token/);

  const workspaces = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.notEqual(workspaces.isError, true);
  assert.deepEqual(workspaces.structuredContent, {
    workspaces: [{ id: "44444444-4444-4444-8444-444444444444", name: "Acme" }],
  });

  const dashboard = await client.callTool({
    name: "get_dashboard",
    arguments: {},
  });
  assert.notEqual(dashboard.isError, true);
  assert.deepEqual(dashboard.structuredContent, {
    readiness: "ready",
    plan: { name: "Pro" },
    usage: {
      used: 7,
      limit: 100,
      periodLabel: "Current month (UTC)",
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-11-01T00:00:00.000Z",
    },
  });

  const conversation = await client.callTool({
    name: "get_conversation",
    arguments: { conversationId: 47 },
  });
  assert.notEqual(conversation.isError, true);
  assert.deepEqual(conversation.structuredContent, {
    conversation: {
      id: 47,
      label: "Conversation #47",
      status: "open",
      messages: [
        {
          id: 700,
          role: "customer",
          authorName: "Customer",
          body: "Need help",
          createdAtLabel: "2026-10-08T00:00:00.000Z",
        },
      ],
      page: { limit: 50, nextCursor: "older-cursor", hasMore: true },
    },
  });

  const status = await client.callTool({
    name: "set_conversation_status",
    arguments: { conversationId: 47, status: "resolved" },
  });
  assert.notEqual(status.isError, true);
  assert.deepEqual(status.structuredContent, {
    conversation: { id: 47, status: "resolved" },
  });

  const email = await client.callTool({
    name: "get_customer_email",
    arguments: {},
  });
  assert.notEqual(email.isError, true);
  assert.deepEqual(email.structuredContent, { enabled: false });
  rejectEmailScope = true;
  const insufficientScope = await client.callTool({
    name: "get_customer_email",
    arguments: {},
  });
  rejectEmailScope = false;
  assert.equal(insufficientScope.isError, true);
  const scopeChallenge =
    (
      insufficientScope as unknown as {
        _meta?: { "mcp/www_authenticate"?: string[] };
      }
    )._meta?.["mcp/www_authenticate"]?.[0] ?? "";
  assert.match(scopeChallenge, /error="insufficient_scope"/);
  assert.match(scopeChallenge, /error_description="[^"]+"/);
  const emailUpdate = await client.callTool({
    name: "set_customer_email",
    arguments: { enabled: true },
  });
  assert.notEqual(emailUpdate.isError, true);
  assert.deepEqual(emailUpdate.structuredContent, { enabled: true });

  const dashboardView = await client.callTool({
    name: "show_dashboard",
    arguments: {},
  });
  assert.notEqual(dashboardView.isError, true);
  assert.deepEqual(dashboardView.structuredContent, { opened: true });
  assert.equal(
    (dashboardView as unknown as { _meta?: { ui?: { resourceUri?: string } } })
      ._meta?.ui?.resourceUri,
    resourceUri,
  );
  assert.deepEqual(
    requests.map(({ method, path }) => [method, path]),
    [
      ["GET", "/v1/profile"],
      ["GET", "/v1/profile"],
      ["GET", "/v1/workspaces"],
      ["GET", "/v1/tenants"],
      ["GET", "/v1/entitlements"],
      ["GET", "/v1/usage"],
      ["GET", `/v1/tenants/${tenantId}/inbox`],
      ["GET", "/v1/tenants"],
      ["GET", `/v1/tenants/${tenantId}/conversations/47`],
      ["GET", `/v1/tenants/${tenantId}/conversations/47/messages`],
      ["GET", "/v1/tenants"],
      ["PATCH", `/v1/tenants/${tenantId}/conversations/47`],
      ["GET", "/v1/tenants"],
      ["GET", `/v1/tenants/${tenantId}/customer-email`],
      ["GET", "/v1/tenants"],
      ["GET", `/v1/tenants/${tenantId}/customer-email`],
      ["GET", "/v1/tenants"],
      ["POST", `/v1/tenants/${tenantId}/customer-email`],
    ],
  );
});
