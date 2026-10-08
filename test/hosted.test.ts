import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  readHostedEnvironment,
  startDaykeeperMcpHttpServer,
} from "../src/index.ts";
import { fakeDaykeeperApi } from "./dashboardFake.ts";

const SECRET = "hosted-introspection-secret-0123456789";
const BEARER = "dk_oat_hostedhostedhostedhostedhostedhosted0";
const PRM =
  "https://api.mydaykeeper.com/.well-known/oauth-protected-resource/mcp";
const ENV = {
  DAYKEEPER_MCP_HTTP_PORT: "0",
  DAYKEEPER_MCP_HTTP_HOST: "127.0.0.1",
  DAYKEEPER_MCP_RESOURCE_URL: "https://api.mydaykeeper.com/mcp",
  DAYKEEPER_INTERNAL_API_URL: "http://daykeeper-api:4100",
  DAYKEEPER_OAUTH_INTROSPECTION_SECRET: SECRET,
  DAYKEEPER_OAUTH_ISSUER: "https://api.mydaykeeper.com",
  DAYKEEPER_MCP_WIDGET_DOMAIN: "https://dashboard.mydaykeeper.com",
};

/** Introspection plus the `/v1` fake, all on the internal network. */
function internalNetwork() {
  const api = fakeDaykeeperApi();
  const introspections: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "http://daykeeper-api:4100/oauth/introspect") {
      introspections.push(request.clone());
      const form = new URLSearchParams(await request.text());
      if (
        request.headers.get("authorization") !== `Bearer ${SECRET}` ||
        form.get("token") !== BEARER
      )
        return Response.json({ active: false });
      return Response.json({
        active: true,
        scope:
          "daykeeper.accounts:read daykeeper.accounts:write daykeeper.billing:read daykeeper.conversations:read daykeeper.conversations:write",
        exp: Math.floor(Date.now() / 1_000) + 1_800,
        client_id: "https://chatgpt.com/oauth/client.json",
        resource: "https://api.mydaykeeper.com/mcp",
        daykeeper_principal_id: "user-1",
        daykeeper_grant_id: "conn-1",
        iss: "https://api.mydaykeeper.com",
      });
    }
    return api.fetch(input, init);
  };
  return { fetch, api, introspections };
}

/**
 * fetch() cannot set Host, so the client transport goes through node:http to
 * present the public Host header Caddy forwards, streaming the answer back.
 */
async function viaListener(address: string, input: Request): Promise<Response> {
  const target = new URL(address);
  const headers: Record<string, string> = {};
  input.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers.host = "api.mydaykeeper.com";
  // As Caddy sets it in front of the MCP host.
  headers["x-forwarded-for"] = "203.0.113.7";
  const body = input.body ? Buffer.from(await input.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: new URL(input.url).pathname,
        method: input.method,
        headers,
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === "string") responseHeaders.set(name, value);
        const status = response.statusCode ?? 500;
        resolve(
          new Response(
            status === 204 || status === 304
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      },
    );
    input.signal.addEventListener("abort", () => outgoing.destroy(), {
      once: true,
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** A raw HTTP request carrying the public Host header, as Caddy forwards it. */
function raw(
  address: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(address);
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: options.method ?? "GET",
        headers: { host: "api.mydaykeeper.com", ...options.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string>,
            body,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

async function start(context: TestContext) {
  const network = internalNetwork();
  const handle = await startDaykeeperMcpHttpServer(ENV, {
    fetch: network.fetch,
  });
  context.after(() => handle.close());
  return { handle, ...network };
}

test("hosted server answers health, metadata and the 401 challenge over real HTTP", async (context) => {
  const { handle, introspections } = await start(context);
  const health = await raw(handle.address, "/healthz", {
    headers: { host: "localhost" },
  });
  assert.equal(health.status, 200);
  assert.equal(health.body, "ok\n");

  const metadata = await raw(
    handle.address,
    "/.well-known/oauth-protected-resource/mcp",
  );
  assert.equal(metadata.status, 200);
  const document = JSON.parse(metadata.body) as Record<string, unknown>;
  assert.equal(document.resource, "https://api.mydaykeeper.com/mcp");
  assert.deepEqual(document.authorization_servers, [
    "https://api.mydaykeeper.com",
  ]);
  assert.deepEqual(document.scopes_supported, [
    "daykeeper.accounts:read",
    "daykeeper.accounts:write",
    "daykeeper.billing:read",
    "daykeeper.conversations:read",
    "daykeeper.conversations:write",
  ]);

  // The API app owns the AS metadata on this origin.
  const as = await raw(
    handle.address,
    "/.well-known/oauth-authorization-server",
  );
  assert.equal(as.status, 404);

  const unauthenticated = await raw(handle.address, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    unauthenticated.headers["www-authenticate"],
    `Bearer resource_metadata="${PRM}"`,
  );

  const forged = await raw(handle.address, "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer dk_oat_not_a_real_token_00000000000000000",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(forged.status, 401);
  assert.match(forged.headers["www-authenticate"] ?? "", /invalid_token/);
  assert.equal(introspections.length, 1);

  const wrongHost = await raw(handle.address, "/mcp", {
    method: "POST",
    headers: { host: "evil.example.test", authorization: `Bearer ${BEARER}` },
    body: "{}",
  });
  assert.equal(wrongHost.status, 403);

  const absolute = await raw(handle.address, "//evil.example.test/mcp");
  assert.equal(absolute.status, 400);
});

test("the official MCP client completes a session against the hosted server", async (context) => {
  const { handle, api, introspections } = await start(context);
  const transport = new StreamableHTTPClientTransport(
    new URL("https://api.mydaykeeper.com/mcp"),
    {
      authProvider: { token: async () => BEARER },
      // Reach the real listener while presenting the public URL and Host.
      fetch: async (input, init) =>
        viaListener(handle.address, new Request(input, init)),
    },
  );
  const client = new Client(
    { name: "daykeeper-hosted-test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  context.after(() => client.close());
  await client.connect(transport, { timeout: 5_000 });
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(tools.length, 10);
  const shown = await client.callTool({
    name: "show_dashboard",
    arguments: {},
  });
  assert.equal(shown.isError ?? false, false);
  assert(!JSON.stringify(shown).includes(BEARER));
  for (const call of api.calls) {
    assert.equal(call.url.origin, "http://daykeeper-api:4100");
    assert.equal(call.authorization, `Bearer ${BEARER}`);
    assert.equal(call.forwardedFor, "203.0.113.7");
  }
  const widget = await client.readResource({
    uri: "ui://daykeeper/dashboard-v1.html",
  });
  const meta = widget.contents[0]!._meta as {
    ui: { domain: string };
    "openai/widgetDomain": string;
  };
  assert.equal(meta.ui.domain, "https://dashboard.mydaykeeper.com");
  assert.equal(
    meta["openai/widgetDomain"],
    "https://dashboard.mydaykeeper.com",
  );
  assert(api.calls.some((call) => call.url.pathname === "/v1/tenants"));
  // Positive introspection results are reused briefly, not per request.
  assert(introspections.length >= 1 && introspections.length < 4);
});

test("hosted configuration is explicit and refuses unsafe internal URLs", async () => {
  assert.equal(
    readHostedEnvironment({ ...ENV, DAYKEEPER_MCP_HTTP_PORT: undefined }).port,
    4108,
  );
  const config = readHostedEnvironment(ENV);
  assert.deepEqual(config.allowedHostnames, ["api.mydaykeeper.com"]);
  assert.deepEqual(config.allowedOrigins, ["https://chatgpt.com"]);
  assert.deepEqual(config.internalHostnames, ["daykeeper-api"]);
  for (const name of [
    "DAYKEEPER_MCP_RESOURCE_URL",
    "DAYKEEPER_INTERNAL_API_URL",
    "DAYKEEPER_OAUTH_INTROSPECTION_SECRET",
    "DAYKEEPER_OAUTH_ISSUER",
    "DAYKEEPER_MCP_WIDGET_DOMAIN",
  ])
    assert.throws(
      () => readHostedEnvironment({ ...ENV, [name]: undefined }),
      new RegExp(name),
    );
  for (const overrides of [
    { DAYKEEPER_MCP_HTTP_PORT: "70000" },
    { DAYKEEPER_MCP_HTTP_PORT: "08" },
    { DAYKEEPER_OAUTH_ISSUER: "https://api.mydaykeeper.com/" },
    { DAYKEEPER_MCP_ALLOWED_ORIGINS: " , " },
    { DAYKEEPER_MCP_WIDGET_DOMAIN: "" },
    { DAYKEEPER_MCP_WIDGET_DOMAIN: "https://dashboard.mydaykeeper.com/" },
    { DAYKEEPER_MCP_WIDGET_DOMAIN: "dashboard.mydaykeeper.com" },
  ])
    assert.throws(() => readHostedEnvironment({ ...ENV, ...overrides }));
  // Plain HTTP only to the allowlisted internal service name.
  for (const overrides of [
    { DAYKEEPER_INTERNAL_API_URL: "http://api.mydaykeeper.com" },
    { DAYKEEPER_INTERNAL_API_URL: "http://10.0.0.4:4100" },
    {
      DAYKEEPER_INTERNAL_API_URL: "http://daykeeper-api:4100",
      DAYKEEPER_MCP_INTERNAL_HOSTNAMES: "other-api",
    },
    { DAYKEEPER_OAUTH_INTROSPECTION_SECRET: "short" },
    { DAYKEEPER_MCP_WIDGET_DOMAIN: "http://widgets.example.test" },
  ])
    await assert.rejects(startDaykeeperMcpHttpServer({ ...ENV, ...overrides }));
  // Secrets never appear in configuration errors.
  await assert.rejects(
    startDaykeeperMcpHttpServer({
      ...ENV,
      DAYKEEPER_INTERNAL_API_URL: "http://daykeeper-api:4100?x=1",
    }),
    (error: unknown) => !String(error).includes(SECRET),
  );
});

test("close stops the listener and later connections are refused", async () => {
  const network = internalNetwork();
  const handle = await startDaykeeperMcpHttpServer(ENV, {
    fetch: network.fetch,
  });
  const address = handle.address;
  await handle.close();
  await handle.close();
  await assert.rejects(raw(address, "/healthz"));
});
