import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createDaykeeperMcpHttpHandler,
  DaykeeperMcpVerifierUnavailableError,
  type DaykeeperMcpHttpOptions,
  type DaykeeperMcpHttpPassthroughOptions,
  type DaykeeperMcpVerifiedAuthInfo,
} from "../src/index.ts";
import { normalizeForwardedFor } from "../src/config.ts";
import { apiError, fakeDaykeeperApi } from "./dashboardFake.ts";

const RESOURCE = new URL("https://api.mydaykeeper.com/mcp");
const ISSUER = "https://api.mydaykeeper.com";
const INTERNAL = new URL("http://daykeeper-api:4100");
const BEARER = "dk_oat_passthroughpassthroughpassthrough0000";
const SCOPES = [
  "daykeeper.accounts:read",
  "daykeeper.accounts:write",
  "daykeeper.billing:read",
  "daykeeper.conversations:read",
  "daykeeper.conversations:write",
];
const PRM_URL =
  "https://api.mydaykeeper.com/.well-known/oauth-protected-resource/mcp";

function auth(
  token: string,
  overrides: Partial<DaykeeperMcpVerifiedAuthInfo> = {},
): DaykeeperMcpVerifiedAuthInfo {
  return {
    token,
    clientId: "https://chatgpt.com/oauth/client.json",
    scopes: [...SCOPES],
    expiresAt: Math.floor(Date.now() / 1_000) + 1_800,
    resource: new URL(RESOURCE.href),
    extra: { daykeeperPrincipalId: "user-1", daykeeperGrantId: "conn-1" },
    ...overrides,
  };
}

function passthrough(
  overrides: Partial<DaykeeperMcpHttpPassthroughOptions> = {},
  fetch?: typeof globalThis.fetch,
): DaykeeperMcpHttpPassthroughOptions {
  return {
    resourceServerUrl: RESOURCE,
    daykeeperApiUrl: INTERNAL,
    authorizationServerIssuer: ISSUER,
    serveAuthorizationServerMetadata: false,
    downstreamCredential: "passthrough",
    passthrough: {
      toolProfile: "dashboard",
      internalHttpHostnames: ["daykeeper-api"],
      ...(fetch ? { fetch } : {}),
    },
    verifier: { verifyAccessToken: async (token) => auth(token) },
    allowedHostnames: [RESOURCE.hostname],
    allowedOrigins: ["https://chatgpt.com"],
    scopesSupported: SCOPES,
    ...overrides,
  };
}

function post(token?: string): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      host: RESOURCE.hostname,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
}

async function connect(
  context: TestContext,
  options: DaykeeperMcpHttpOptions,
  forwardedFor?: string,
) {
  const handler = createDaykeeperMcpHttpHandler(options);
  const transport = new StreamableHTTPClientTransport(RESOURCE, {
    authProvider: { token: async () => BEARER },
    fetch: async (input, init) => {
      const incoming = new Request(input, init);
      const headers = new Headers(incoming.headers);
      headers.set("host", RESOURCE.hostname);
      if (forwardedFor !== undefined)
        headers.set("x-forwarded-for", forwardedFor);
      return handler.fetch(new Request(incoming, { headers }));
    },
  });
  const client = new Client(
    { name: "daykeeper-passthrough-test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  context.after(async () => {
    await client.close();
    await handler.close();
  });
  await client.connect(transport, { timeout: 3_000 });
  return client;
}

test("pass-through cannot be enabled implicitly or half-configured", () => {
  const exchange = {
    ...passthrough(),
    downstreamCredential: undefined,
    passthrough: undefined,
    resolvePrincipal: async () => null,
    daykeeperApiUrl: new URL("https://api.example.test"),
  };
  // The exchange baseline itself is valid.
  assert.doesNotThrow(() =>
    createDaykeeperMcpHttpHandler(
      exchange as unknown as DaykeeperMcpHttpOptions,
    ).close(),
  );
  const invalid: Array<[string, Record<string, unknown>]> = [
    // A pass-through block without the explicit mode is not an opt-in.
    [
      "block without mode",
      { ...exchange, passthrough: passthrough().passthrough },
    ],
    [
      "block without mode or resolver",
      { ...passthrough(), downstreamCredential: undefined },
    ],
    [
      "exchange with block",
      { ...passthrough(), downstreamCredential: "exchange" },
    ],
    // The mode is an exact literal, never truthiness or a variant spelling.
    ["boolean", { ...passthrough(), downstreamCredential: true }],
    ["spelling", { ...passthrough(), downstreamCredential: "pass-through" }],
    ["case", { ...passthrough(), downstreamCredential: "Passthrough" }],
    // Pass-through never runs alongside a resolver that could mix modes.
    ["with resolver", { ...passthrough(), resolvePrincipal: async () => null }],
    ["without settings", { ...passthrough(), passthrough: undefined }],
    [
      "without a fixed profile",
      {
        ...passthrough(),
        passthrough: { internalHttpHostnames: ["daykeeper-api"] },
      },
    ],
    [
      "unknown profile",
      {
        ...passthrough(),
        passthrough: {
          toolProfile: "admin",
          internalHttpHostnames: ["daykeeper-api"],
        },
      },
    ],
    // Plain HTTP to the API only for an explicitly allowlisted private host.
    [
      "http host not allowlisted",
      { ...passthrough(), passthrough: { toolProfile: "dashboard" } },
    ],
    [
      "http to another host",
      { ...passthrough(), daykeeperApiUrl: new URL("http://evil-api:4100") },
    ],
    [
      "http IP literal",
      {
        ...passthrough(),
        daykeeperApiUrl: new URL("http://10.0.0.4:4100"),
        passthrough: {
          toolProfile: "dashboard",
          internalHttpHostnames: ["10.0.0.4"],
        },
      },
    ],
    // Exchange mode stays HTTPS-only even with an allowlist elsewhere.
    ["exchange over http", { ...exchange, daykeeperApiUrl: INTERNAL }],
    // AS metadata cannot be served without AS metadata.
    [
      "serve metadata from issuer only",
      { ...passthrough(), serveAuthorizationServerMetadata: true },
    ],
    [
      "both metadata sources",
      {
        ...passthrough(),
        oauthMetadata: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        },
      },
    ],
    [
      "no metadata source",
      { ...passthrough(), authorizationServerIssuer: undefined },
    ],
    [
      "issuer slash",
      { ...passthrough(), authorizationServerIssuer: `${ISSUER}/` },
    ],
    [
      "issuer http",
      {
        ...passthrough(),
        authorizationServerIssuer: "http://api.mydaykeeper.com",
      },
    ],
  ];
  for (const [label, candidate] of invalid)
    assert.throws(
      () =>
        createDaykeeperMcpHttpHandler(
          candidate as unknown as DaykeeperMcpHttpOptions,
        ),
      /Invalid Daykeeper MCP HTTP configuration/,
      label,
    );
});

test("the default exchange mode still refuses to forward the MCP bearer", async () => {
  let calls = 0;
  const handler = createDaykeeperMcpHttpHandler({
    resourceServerUrl: RESOURCE,
    daykeeperApiUrl: new URL("https://api.example.test"),
    authorizationServerIssuer: ISSUER,
    serveAuthorizationServerMetadata: false,
    verifier: { verifyAccessToken: async (token) => auth(token) },
    resolvePrincipal: async () => ({
      principalId: "user-1",
      grantId: "conn-1",
      downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 60,
      daykeeper: {
        baseUrl: "https://api.example.test",
        accessToken: BEARER,
        scopes: SCOPES,
        fetch: async () => {
          calls++;
          return Response.json({ data: [] });
        },
      },
    }),
    allowedHostnames: [RESOURCE.hostname],
  });
  const refused = await handler.fetch(post(BEARER));
  assert.equal(refused.status, 503);
  assert.equal(calls, 0);
  await handler.close();
});

test("pass-through forwards the same bearer to the internal API and serves the ten dashboard tools", async (context) => {
  const api = fakeDaykeeperApi();
  const client = await connect(context, passthrough({}, api.fetch));
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(tools.length, 10);
  assert(tools.includes("show_dashboard"));
  assert(!tools.some((name) => name.startsWith("daykeeper_")));
  const result = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(result.isError ?? false, false);
  assert(!JSON.stringify(result).includes(BEARER));
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.url.href, "http://daykeeper-api:4100/v1/tenants");
  assert.equal(api.calls[0]!.authorization, `Bearer ${BEARER}`);
  const profile = await client.callTool({ name: "get_profile", arguments: {} });
  assert.equal(profile.isError ?? false, false);
  assert.equal(api.calls[1]!.url.href, "http://daykeeper-api:4100/v1/me");
});

test("pass-through refuses a token issued for another resource before any API call", async () => {
  const api = fakeDaykeeperApi();
  for (const resource of [
    new URL("https://api.mydaykeeper.com/other"),
    new URL("https://api.mydaykeeper.com/mcp#"),
    new URL("https://evil.example.test/mcp"),
  ]) {
    const handler = createDaykeeperMcpHttpHandler(
      passthrough(
        {
          verifier: {
            verifyAccessToken: async (token) => auth(token, { resource }),
          },
        },
        api.fetch,
      ),
    );
    const response = await handler.fetch(post(BEARER));
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate") ?? "",
      /invalid_token/,
    );
    await handler.close();
  }
  assert.equal(api.calls.length, 0);
});

test("pass-through binds one bearer to one principal and grant", async () => {
  const api = fakeDaykeeperApi();
  let grant = "conn-1";
  const handler = createDaykeeperMcpHttpHandler(
    passthrough(
      {
        verifier: {
          verifyAccessToken: async (token) =>
            auth(token, {
              extra: {
                daykeeperPrincipalId: "user-1",
                daykeeperGrantId: grant,
              },
            }),
        },
      },
      api.fetch,
    ),
  );
  const first = await handler.fetch(post(BEARER));
  assert.equal(first.status, 200);
  await first.body?.cancel();
  grant = "conn-2";
  const second = await handler.fetch(post(BEARER));
  assert.equal(second.status, 503);
  await handler.close();
});

test("protected-resource metadata names Daykeeper's issuer, the resource and the five scopes; AS metadata is not served", async () => {
  const handler = createDaykeeperMcpHttpHandler(passthrough());
  const prm = await handler.fetch(
    new Request(PRM_URL, { headers: { host: RESOURCE.hostname } }),
  );
  assert.equal(prm.status, 200);
  const document = (await prm.json()) as Record<string, unknown>;
  assert.deepEqual(document.authorization_servers, [ISSUER]);
  assert.equal(document.resource, "https://api.mydaykeeper.com/mcp");
  assert.deepEqual(document.scopes_supported, SCOPES);
  const as = await handler.fetch(
    new Request(`${ISSUER}/.well-known/oauth-authorization-server`, {
      headers: { host: RESOURCE.hostname },
    }),
  );
  assert.equal(as.status, 404);
  const missing = await handler.fetch(post());
  assert.equal(missing.status, 401);
  assert.equal(
    missing.headers.get("www-authenticate"),
    `Bearer resource_metadata="${PRM_URL}"`,
  );
  await handler.close();
});

test("AS metadata stays on by default for existing hosts", async () => {
  const oauthMetadata = {
    issuer: ISSUER,
    authorization_endpoint: "https://console.mydaykeeper.com/oauth/authorize",
    token_endpoint: `${ISSUER}/oauth/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
  const handler = createDaykeeperMcpHttpHandler({
    ...passthrough(),
    authorizationServerIssuer: undefined,
    serveAuthorizationServerMetadata: undefined,
    oauthMetadata,
  });
  const as = await handler.fetch(
    new Request(`${ISSUER}/.well-known/oauth-authorization-server`, {
      headers: { host: RESOURCE.hostname },
    }),
  );
  assert.equal(as.status, 200);
  assert.deepEqual(await as.json(), oauthMetadata);
  await handler.close();
});

test("a verifier outage is a 503, not a re-authorization challenge", async () => {
  const handler = createDaykeeperMcpHttpHandler(
    passthrough({
      verifier: {
        verifyAccessToken: async () => {
          throw new DaykeeperMcpVerifierUnavailableError();
        },
      },
    }),
  );
  const response = await handler.fetch(post(BEARER));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("www-authenticate"), null);
  const invalid = createDaykeeperMcpHttpHandler(
    passthrough({
      verifier: {
        verifyAccessToken: async () => {
          throw new Error("inactive");
        },
      },
    }),
  );
  const rejected = await invalid.fetch(post(BEARER));
  assert.equal(rejected.status, 401);
  assert.equal(
    rejected.headers.get("www-authenticate"),
    `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`,
  );
  await handler.close();
  await invalid.close();
});

test("forwarded-for chains are strictly bare IP literals, at most 8 and 512 characters", () => {
  assert.equal(normalizeForwardedFor("203.0.113.7"), "203.0.113.7");
  assert.equal(
    normalizeForwardedFor("203.0.113.7,  10.0.0.2 ,2001:db8::1"),
    "203.0.113.7, 10.0.0.2, 2001:db8::1",
  );
  assert.equal(
    normalizeForwardedFor(
      Array.from({ length: 8 }, () => "10.0.0.1").join(","),
    ),
    Array.from({ length: 8 }, () => "10.0.0.1").join(", "),
  );
  for (const value of [
    undefined,
    null,
    "",
    " ",
    "unknown",
    "203.0.113.7:443",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "203.0.113.7,,10.0.0.1",
    "203.0.113.7, evil.example.test",
    "203.0.113.7\r\nx-injected: 1",
    "256.0.0.1",
    Array.from({ length: 9 }, () => "10.0.0.1").join(","),
    Array.from(
      { length: 8 },
      () => "2001:0db8:0000:0000:0000:ff00:0042:8329",
    ).join(",") + "x".repeat(200),
    "1".repeat(513),
  ])
    assert.equal(normalizeForwardedFor(value), undefined, String(value));
});

test("pass-through forwards the proxy's X-Forwarded-For to SDK and dashboard API calls", async (context) => {
  const api = fakeDaykeeperApi();
  const client = await connect(
    context,
    passthrough({}, api.fetch),
    "203.0.113.7, 10.0.0.5",
  );
  // tenants.list goes through the SDK; /v1/me through the dashboard client.
  await client.callTool({ name: "list_workspaces", arguments: {} });
  await client.callTool({ name: "get_profile", arguments: {} });
  await client.callTool({ name: "get_dashboard", arguments: {} });
  assert(api.calls.length >= 6);
  for (const call of api.calls)
    assert.equal(call.forwardedFor, "203.0.113.7, 10.0.0.5", call.url.pathname);
});

test("a malformed X-Forwarded-For is dropped, not forwarded", async (context) => {
  for (const forwarded of [
    "203.0.113.7, not-an-ip",
    Array.from({ length: 9 }, () => "10.0.0.1").join(","),
    "203.0.113.7:8443",
  ]) {
    const api = fakeDaykeeperApi();
    const client = await connect(
      context,
      passthrough({}, api.fetch),
      forwarded,
    );
    await client.callTool({ name: "list_workspaces", arguments: {} });
    await client.callTool({ name: "get_profile", arguments: {} });
    assert.equal(api.calls.length, 2);
    for (const call of api.calls) assert.equal(call.forwardedFor, null);
  }
});

test("X-Forwarded-For is never forwarded in exchange mode or to a non-allowlisted API host", async (context) => {
  // Exchange mode: neither the incoming header nor a resolver-supplied value.
  const exchangeApi = fakeDaykeeperApi();
  const exchange = await connect(
    context,
    {
      resourceServerUrl: RESOURCE,
      daykeeperApiUrl: new URL("https://api.example.test"),
      authorizationServerIssuer: ISSUER,
      serveAuthorizationServerMetadata: false,
      verifier: { verifyAccessToken: async (token) => auth(token) },
      resolvePrincipal: async () => ({
        principalId: "user-1",
        grantId: "conn-1",
        downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 60,
        daykeeper: {
          baseUrl: "https://api.example.test",
          accessToken: "dk_downstream_exchange_credential_0001",
          scopes: ["daykeeper.accounts:read"],
          forwardedFor: "198.51.100.9",
          internalHttpHostnames: ["api.example.test"],
          fetch: exchangeApi.fetch,
        },
      }),
      allowedHostnames: [RESOURCE.hostname],
    },
    "203.0.113.7",
  );
  await exchange.callTool({ name: "daykeeper_tenants_list", arguments: {} });
  assert.equal(exchangeApi.calls.length, 1);
  assert.equal(exchangeApi.calls[0]!.forwardedFor, null);

  // Pass-through to an HTTPS API host that is not on the internal allowlist.
  const publicApi = fakeDaykeeperApi();
  const outside = await connect(
    context,
    passthrough(
      { daykeeperApiUrl: new URL("https://api.example.test") },
      publicApi.fetch,
    ),
    "203.0.113.7",
  );
  await outside.callTool({ name: "list_workspaces", arguments: {} });
  await outside.callTool({ name: "get_profile", arguments: {} });
  assert.equal(publicApi.calls.length, 2);
  for (const call of publicApi.calls) assert.equal(call.forwardedFor, null);
});

test("a token revoked mid-session yields the reconnect challenge on the tool result", async (context) => {
  const api = fakeDaykeeperApi({
    override: () => apiError(401, "UNAUTHENTICATED"),
  });
  const client = await connect(context, passthrough({}, api.fetch));
  const result = await client.callTool({
    name: "get_dashboard",
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result._meta?.["mcp/www_authenticate"], [
    `Bearer resource_metadata="${PRM_URL}", error="invalid_token", error_description="Your Daykeeper connection has expired or was revoked. Reconnect Daykeeper to continue."`,
  ]);
  assert(!JSON.stringify(result).includes(BEARER));
});
