import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkSupportsDashboard } from "../src/sdkDashboard.ts";
import { createDashboardHostedHandler } from "../src/dashboardHosted.ts";

const welcomeMessage =
  "Welcome to Daykeeper! Customer live chat for small teams in the age of AI. Create your account or connect your existing account to get started.";

function mcpRequest(
  method: string,
  id?: number,
  params: unknown = {},
  token?: string,
) {
  const headers = new Headers({
    host: "dashboard.example.test",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://dashboard.example.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      params,
    }),
  });
}

async function responseMessage(response: Response) {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const json = dataLine ? dataLine.slice(6).trim() : body;
  return JSON.parse(json) as Record<string, any>;
}

test("hosted OAuth metadata advertises RFC 9207 authorization response issuer support", async (context) => {
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
  });
  context.after(async () => handler.close());

  const response = await handler.fetch(
    new Request(
      "https://dashboard.example.test/.well-known/oauth-authorization-server",
      {
        headers: { host: "dashboard.example.test" },
      },
    ),
  );
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as Record<string, unknown>;
  assert.equal(metadata.issuer, "https://app.mydaykeeper.com");
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, true);
});

test("signed-out dashboard supports discovery and data-free profile/read/write challenges", async (context) => {
  let apiCalls = 0;
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
    fetchImpl: async () => {
      apiCalls++;
      throw new Error(
        "Signed-out requests must not contact the management API.",
      );
    },
  });
  context.after(async () => handler.close());

  const initialize = await handler.fetch(
    mcpRequest("initialize", 1, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dashboard-test", version: "1.0.0" },
    }),
  );
  assert.equal(initialize.status, 200);
  assert.equal(
    (await responseMessage(initialize)).result.serverInfo.name,
    "daykeeper-dashboard",
  );

  const initialized = await handler.fetch(
    mcpRequest("notifications/initialized"),
  );
  assert.ok([200, 202].includes(initialized.status));
  const ping = await handler.fetch(mcpRequest("ping", 2));
  assert.equal(ping.status, 200);
  assert.deepEqual((await responseMessage(ping)).result, {});

  const list = await handler.fetch(mcpRequest("tools/list", 3));
  assert.equal(list.status, 200);
  const tools = (await responseMessage(list)).result.tools as Array<
    Record<string, any>
  >;
  assert.equal(tools.length, 10);
  const profile = tools.find((tool) => tool.name === "get_profile");
  assert.deepEqual(profile?.securitySchemes, [
    { type: "noauth" },
    {
      type: "oauth2",
      scopes: [
        "daykeeper.accounts:read",
        "daykeeper.billing:read",
        "daykeeper.conversations:read",
      ],
    },
  ]);
  for (const tool of tools.filter(
    (candidate) => candidate.name !== "get_profile",
  ))
    assert.deepEqual(
      tool.securitySchemes.map((scheme: any) => scheme.type),
      ["oauth2"],
    );

  for (const method of ["resources/list", "resources/templates/list"]) {
    const result = await handler.fetch(mcpRequest(method, 4));
    assert.equal(result.status, 200);
    const envelope = (await responseMessage(result)).result;
    assert.equal((envelope.resources ?? envelope.resourceTemplates).length, 0);
  }

  const challenge = await handler.fetch(
    mcpRequest("tools/call", 5, { name: "get_profile", arguments: {} }),
  );
  assert.equal(challenge.status, 200);
  const toolError = (await responseMessage(challenge)).result;
  assert.equal(toolError.isError, true);
  assert.equal(toolError.structuredContent, undefined);
  assert.equal(toolError.content[0].text, welcomeMessage);
  assert.match(
    toolError._meta["mcp/www_authenticate"][0],
    /resource_metadata="https:\/\/dashboard\.example\.test\//,
  );

  const readChallenge = await handler.fetch(
    mcpRequest("tools/call", 6, {
      name: "list_conversations",
      arguments: { limit: 20 },
    }),
  );
  const readError = (await responseMessage(readChallenge)).result;
  assert.equal(readChallenge.status, 200);
  assert.equal(readError.isError, true);
  assert.equal(readError.structuredContent, undefined);
  assert.equal(readError.content[0].text, welcomeMessage);
  assert.match(
    readError._meta["mcp/www_authenticate"][0],
    /scope="daykeeper\.accounts:read daykeeper\.conversations:read"/,
  );

  const writeChallenge = await handler.fetch(
    mcpRequest("tools/call", 7, {
      name: "send_reply",
      arguments: {
        conversationId: 42,
        body: "Hello",
        requestId: "f438c908-b8dc-4c19-9d78-c3b3c4f24a6c",
      },
    }),
  );
  const writeError = (await responseMessage(writeChallenge)).result;
  assert.equal(writeChallenge.status, 200);
  assert.equal(writeError.isError, true);
  assert.equal(writeError.structuredContent, undefined);
  assert.match(
    writeError._meta["mcp/www_authenticate"][0],
    /scope="daykeeper\.accounts:read daykeeper\.conversations:write"/,
  );

  const protectedRead = await handler.fetch(
    mcpRequest("resources/read", 8, {
      uri: "ui://daykeeper-dashboard/dashboard.html",
    }),
  );
  assert.equal(protectedRead.status, 401);
  assert.match(
    protectedRead.headers.get("www-authenticate") ?? "",
    /resource_metadata=/,
  );
  assert.equal(apiCalls, 0);
});

test("an inactive token falls back to a data-free tool sign-in challenge", async (context) => {
  let introspections = 0;
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
    fetchImpl: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/v1/oauth/introspect");
      introspections++;
      return Response.json({ data: { active: false } });
    },
  });
  context.after(async () => handler.close());

  const response = await handler.fetch(
    mcpRequest(
      "tools/call",
      1,
      { name: "get_profile", arguments: {} },
      "expired-dashboard-token",
    ),
  );
  assert.equal(response.status, 200);
  const result = (await responseMessage(response)).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content[0].text, welcomeMessage);
  assert.ok(result._meta["mcp/www_authenticate"][0].includes("invalid_token"));
  assert.equal(introspections, 1);
});

test("candidate SDK: limited grants challenge dashboard reads before API access, then work after read-scope upgrade", async (context) => {
  if (!sdkSupportsDashboard()) {
    context.skip("installed SDK does not expose the dashboard methods");
    return;
  }
  const grantedScopes = ["daykeeper.accounts:read"];
  const apiRequests: string[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname;
      apiRequests.push(path);
      if (path === "/v1/profile")
        return Response.json({
          data: {
            userId: "33333333-3333-4333-8333-333333333333",
            name: "Alex",
            email: "alex@example.test",
            organizationId: "44444444-4444-4444-8444-444444444444",
            workspace: {
              organizationId: "44444444-4444-4444-8444-444444444444",
              name: "Acme",
            },
          },
        });
      if (path === "/v1/tenants")
        return Response.json({
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              state: "ready",
              createdAt: "2026-02-01T00:00:00.000Z",
              spec: { inbox: { type: "api" } },
            },
          ],
        });
      if (path === "/v1/entitlements")
        return Response.json({ data: { policy: { plan: "pro" } } });
      if (path === "/v1/usage")
        return Response.json({
          data: { resources: { conversationRecords: { used: 7, limit: 100 } } },
        });
      if (path.endsWith("/inbox"))
        return Response.json({ data: { trafficEnabled: true } });
      if (path.endsWith("/customer-email"))
        return Response.json({ data: { enabled: false } });
      if (path.endsWith("/conversations"))
        return Response.json({
          data: { conversations: [], page: { limit: 20 } },
        });
      throw new Error(`Unexpected dashboard API request: ${path}`);
    },
  );
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/oauth/introspect")
        return Response.json({
          data: {
            active: true,
            resource: "https://dashboard.example.test/mcp",
            clientId: "dashboard-client",
            connectionId: "connection-1",
            userId: "33333333-3333-4333-8333-333333333333",
            organizationId: "44444444-4444-4444-8444-444444444444",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            scopes: grantedScopes,
          },
        });
      if (path === "/v1/oauth/exchange")
        return Response.json({
          data: {
            access_token: "daykeeper-exchanged-api-token-123456789",
            token_type: "Bearer",
            expires_in: 300,
          },
        });
      throw new Error(`Unexpected OAuth request: ${path}`);
    },
  });
  context.after(async () => handler.close());

  const limitedGrantChecks = [
    [
      1,
      "get_profile",
      {},
      [
        "daykeeper.accounts:read",
        "daykeeper.billing:read",
        "daykeeper.conversations:read",
      ],
    ],
    [
      2,
      "get_dashboard",
      {},
      ["daykeeper.accounts:read", "daykeeper.billing:read"],
    ],
    [
      3,
      "list_conversations",
      { limit: 20 },
      ["daykeeper.accounts:read", "daykeeper.conversations:read"],
    ],
  ] as const;
  for (const [id, name, args, requiredScopes] of limitedGrantChecks) {
    const response = await handler.fetch(
      mcpRequest("tools/call", id, { name, arguments: args }, "limited-token"),
    );
    const result = (await responseMessage(response)).result;
    assert.equal(response.status, 200);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "SCOPE_NOT_GRANTED");
    assert.equal(result.structuredContent.error.status, 403);
    assert.match(
      result.content[0].text,
      /signed-in connection needs these permissions/i,
    );
    const challenge = result._meta["mcp/www_authenticate"][0];
    assert.match(challenge, /error="insufficient_scope"/);
    assert.ok(challenge.includes(`scope="${requiredScopes.join(" ")}"`));
  }
  assert.deepEqual(apiRequests, []);

  const emailResponse = await handler.fetch(
    mcpRequest(
      "tools/call",
      7,
      { name: "get_customer_email", arguments: {} },
      "limited-token",
    ),
  );
  const emailResult = (await responseMessage(emailResponse)).result;
  assert.equal(emailResponse.status, 200);
  assert.notEqual(emailResult.isError, true);
  assert.deepEqual(emailResult.structuredContent, { enabled: false });
  assert.deepEqual(apiRequests, [
    "/v1/tenants",
    "/v1/tenants/11111111-1111-4111-8111-111111111111/customer-email",
  ]);

  grantedScopes.push("daykeeper.billing:read", "daykeeper.conversations:read");
  for (const [id, name, args] of [
    [4, "get_profile", {}],
    [5, "get_dashboard", {}],
    [6, "list_conversations", { limit: 20 }],
  ] as const) {
    const response = await handler.fetch(
      mcpRequest("tools/call", id, { name, arguments: args }, "upgraded-token"),
    );
    const result = (await responseMessage(response)).result;
    assert.equal(response.status, 200);
    assert.notEqual(result.isError, true);
  }
  assert.deepEqual(
    apiRequests.sort(),
    [
      "/v1/profile",
      "/v1/tenants",
      "/v1/tenants",
      "/v1/tenants",
      "/v1/entitlements",
      "/v1/usage",
      "/v1/tenants/11111111-1111-4111-8111-111111111111/inbox",
      "/v1/tenants/11111111-1111-4111-8111-111111111111/customer-email",
      "/v1/tenants/11111111-1111-4111-8111-111111111111/conversations",
    ].sort(),
  );
});

test("candidate SDK: authenticated startup discovery is static during a concurrent host burst", async (context) => {
  if (!sdkSupportsDashboard()) {
    context.skip("installed SDK does not expose the dashboard methods");
    return;
  }
  let introspections = 0;
  let exchanges = 0;
  let profileReads = 0;
  context.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname;
      assert.equal(path, "/v1/profile");
      profileReads++;
      return Response.json({
        data: {
          userId: "33333333-3333-4333-8333-333333333333",
          name: "Alex",
          email: "alex@example.test",
          organizationId: "44444444-4444-4444-8444-444444444444",
          workspace: {
            organizationId: "44444444-4444-4444-8444-444444444444",
            name: "Acme",
          },
        },
      });
    },
  );
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/oauth/introspect") {
        introspections++;
        return Response.json({
          data: {
            active: true,
            resource: "https://dashboard.example.test/mcp",
            clientId: "dashboard-client",
            connectionId: "connection-1",
            userId: "33333333-3333-4333-8333-333333333333",
            organizationId: "44444444-4444-4444-8444-444444444444",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            scopes: [
              "daykeeper.accounts:read",
              "daykeeper.billing:read",
              "daykeeper.conversations:read",
            ],
          },
        });
      }
      if (path === "/v1/oauth/exchange") {
        exchanges++;
        return Response.json({
          data: {
            access_token: "daykeeper-exchanged-api-token-123456789",
            token_type: "Bearer",
            expires_in: 300,
          },
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    },
  });
  context.after(async () => handler.close());

  await Promise.all(
    Array.from({ length: 80 }, async (_, index) => {
      const token =
        index % 2 === 0 ? "same-valid-looking-token" : `token-${index}`;
      const initialize = await handler.fetch(
        mcpRequest(
          "initialize",
          index * 3 + 1,
          {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: `dashboard-test-${index}`, version: "1.0.0" },
          },
          token,
        ),
      );
      assert.equal(initialize.status, 200);
      assert.equal(
        (await responseMessage(initialize)).result.serverInfo.name,
        "daykeeper-dashboard",
      );

      const initialized = await handler.fetch(
        mcpRequest("notifications/initialized", undefined, {}, token),
      );
      assert.ok([200, 202].includes(initialized.status));

      const list = await handler.fetch(
        mcpRequest("tools/list", index * 3 + 2, {}, token),
      );
      assert.equal(list.status, 200);
      assert.equal((await responseMessage(list)).result.tools.length, 10);
    }),
  );
  assert.equal(introspections, 0);
  assert.equal(exchanges, 0);
  assert.equal(profileReads, 0);

  const protectedResources = await handler.fetch(
    mcpRequest("resources/list", 500, {}, "valid-resource-token"),
  );
  assert.equal(protectedResources.status, 200);
  await protectedResources.text();
  assert.equal(introspections, 1);
  assert.equal(exchanges, 1);

  const unauthenticatedProfile = await handler.fetch(
    mcpRequest("tools/call", 501, { name: "get_profile", arguments: {} }),
  );
  assert.equal(unauthenticatedProfile.status, 200);
  assert.equal(
    (await responseMessage(unauthenticatedProfile)).result.content[0].text,
    welcomeMessage,
  );
  assert.equal(introspections, 1);

  const authenticatedProfile = await handler.fetch(
    mcpRequest(
      "tools/call",
      502,
      { name: "get_profile", arguments: {} },
      "real-profile-token",
    ),
  );
  assert.equal(authenticatedProfile.status, 200);
  assert.deepEqual(
    (await responseMessage(authenticatedProfile)).result.structuredContent,
    {
      userId: "33333333-3333-4333-8333-333333333333",
      name: "Alex",
      email: "alex@example.test",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceName: "Acme",
      workspace: {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Acme",
      },
    },
  );
  assert.equal(introspections, 2);
  assert.equal(exchanges, 2);
  assert.equal(profileReads, 1);
});

test("candidate SDK: hosted dashboard accepts 20 concurrent authenticated calls for one principal", async (context) => {
  if (!sdkSupportsDashboard()) {
    context.skip("installed SDK does not expose the dashboard methods");
    return;
  }
  const concurrentCalls = 20;
  let introspections = 0;
  let exchanges = 0;
  let profileReads = 0;
  let releaseProfiles!: () => void;
  const allProfilesStarted = new Promise<void>((resolve) => {
    releaseProfiles = resolve;
  });
  context.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname;
      assert.equal(path, "/v1/profile");
      profileReads++;
      if (profileReads === concurrentCalls) releaseProfiles();
      await allProfilesStarted;
      return Response.json({
        data: {
          userId: "33333333-3333-4333-8333-333333333333",
          name: "Alex",
          email: "alex@example.test",
          organizationId: "44444444-4444-4444-8444-444444444444",
          workspace: {
            organizationId: "44444444-4444-4444-8444-444444444444",
            name: "Acme",
          },
        },
      });
    },
  );
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/oauth/introspect") {
        introspections++;
        return Response.json({
          data: {
            active: true,
            resource: "https://dashboard.example.test/mcp",
            clientId: "dashboard-client",
            connectionId: "connection-1",
            userId: "33333333-3333-4333-8333-333333333333",
            organizationId: "44444444-4444-4444-8444-444444444444",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            scopes: [
              "daykeeper.accounts:read",
              "daykeeper.billing:read",
              "daykeeper.conversations:read",
            ],
          },
        });
      }
      if (path === "/v1/oauth/exchange") {
        exchanges++;
        return Response.json({
          data: {
            access_token: "daykeeper-exchanged-api-token-123456789",
            token_type: "Bearer",
            expires_in: 300,
          },
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    },
  });
  context.after(async () => handler.close());

  const results = await Promise.all(
    Array.from({ length: concurrentCalls }, async (_, index) => {
      const response = await handler.fetch(
        mcpRequest(
          "tools/call",
          700 + index,
          { name: "get_profile", arguments: {} },
          "same-valid-looking-token",
        ),
      );
      assert.equal(response.status, 200);
      return (await responseMessage(response)).result;
    }),
  );

  assert.equal(introspections, concurrentCalls);
  assert.equal(exchanges, concurrentCalls);
  assert.equal(profileReads, concurrentCalls);
  for (const result of results) {
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.email, "alex@example.test");
  }
});

test("a token verification service outage stays an HTTP 503", async (context) => {
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
    fetchImpl: async () => {
      throw new Error("temporary outage");
    },
  });
  context.after(async () => handler.close());

  const response = await handler.fetch(
    mcpRequest(
      "tools/call",
      1,
      { name: "get_profile", arguments: {} },
      "valid-looking-token",
    ),
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /authentication is unavailable/i);
});
