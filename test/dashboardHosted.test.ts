import assert from "node:assert/strict";
import { test } from "node:test";
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
    { type: "oauth2", scopes: ["daykeeper.accounts:read"] },
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
