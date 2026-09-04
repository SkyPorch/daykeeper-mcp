import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import {
  createDaykeeperMcpHttpHandler,
  MAX_HTTP_AUTHENTICATION_MS,
  MAX_HTTP_CONCURRENT_AUTHENTICATIONS,
  MAX_HTTP_CONCURRENT_REQUESTS,
  MAX_HTTP_CONCURRENT_REQUESTS_PER_PRINCIPAL,
  MAX_HTTP_REQUEST_BYTES,
  MAX_HTTP_REQUEST_READ_MS,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_HTTP_RESPONSE_READ_MS,
  type DaykeeperMcpHttpOptions,
  type DaykeeperMcpHttpPrincipal,
  type DaykeeperMcpTokenVerifier,
  type DaykeeperMcpVerifiedAuthInfo,
} from "../src/index.ts";
import { BASE_URL, bounded, deferred } from "./helpers.ts";

const RESOURCE = new URL("https://mcp.example.test/mcp");
const MCP_TOKEN = "daykeeper_mcp_remote_bearer_123456789";
const DOWNSTREAM_TOKEN = "daykeeper_mcp_downstream_123456789";
const OAUTH: OAuthMetadata = {
  issuer: "https://auth.example.test",
  authorization_endpoint: "https://auth.example.test/authorize",
  token_endpoint: "https://auth.example.test/token",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
};

function authInfo(
  token = MCP_TOKEN,
  resource = RESOURCE,
  clientId = "synthetic-client",
  overrides: Partial<DaykeeperMcpVerifiedAuthInfo> = {},
): DaykeeperMcpVerifiedAuthInfo {
  return {
    token,
    clientId,
    scopes: ["daykeeper.tenants:read"],
    expiresAt: Math.floor(Date.now() / 1_000) + 300,
    resource,
    extra: {
      daykeeperPrincipalId: "principal-1",
      daykeeperGrantId: "grant-1",
    },
    ...overrides,
  };
}

function principal(
  overrides: Partial<DaykeeperMcpHttpPrincipal> = {},
): DaykeeperMcpHttpPrincipal {
  return {
    principalId: "principal-1",
    grantId: "grant-1",
    downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 120,
    daykeeper: {
      baseUrl: BASE_URL,
      accessToken: DOWNSTREAM_TOKEN,
      scopes: ["daykeeper.tenants:read"],
      fetch: async () => {
        throw new Error("Unexpected downstream request");
      },
    },
    ...overrides,
  };
}

function options(
  overrides: Partial<DaykeeperMcpHttpOptions> = {},
): DaykeeperMcpHttpOptions {
  return {
    resourceServerUrl: RESOURCE,
    daykeeperApiUrl: new URL(BASE_URL),
    oauthMetadata: OAUTH,
    allowedHostnames: [RESOURCE.hostname],
    allowedOrigins: ["https://console.example.test"],
    verifier: {
      verifyAccessToken: async (token) => authInfo(token),
    },
    resolvePrincipal: async () => principal(),
    scopesSupported: ["daykeeper.tenants:read"],
    ...overrides,
  };
}

function request(
  path: string,
  init: RequestInit = {},
  authenticated = false,
): Request {
  const headers = new Headers(init.headers);
  headers.set("host", RESOURCE.hostname);
  if (authenticated) headers.set("authorization", `Bearer ${MCP_TOKEN}`);
  return new Request(new URL(path, RESOURCE), { ...init, headers });
}

test("HTTP configuration is HTTPS, canonical, PKCE-capable and explicitly host-bound", () => {
  for (const candidate of [
    { allowedHostnames: [] },
    { resourceServerUrl: new URL("https://mcp.example.test/") },
    { resourceServerUrl: new URL("https://mcp.example.test/mcp/") },
    { resourceServerUrl: new URL("http://mcp.example.test/mcp") },
    {
      oauthMetadata: { ...OAUTH, code_challenge_methods_supported: [] },
    },
    {
      oauthMetadata: { ...OAUTH, response_types_supported: ["token"] },
    },
    { allowedOrigins: ["http://console.example.test"] },
    { allowedOrigins: ["https://console.example.test:443"] },
    { maxConcurrentRequests: 0 },
    { maxRequestBytes: 4_194_305 },
  ]) {
    assert.throws(
      () => createDaykeeperMcpHttpHandler(options(candidate)),
      /Invalid Daykeeper MCP HTTP configuration/,
    );
  }
});

test("OAuth discovery is public but host-gated and path-aware", async () => {
  let verified = 0;
  const handler = createDaykeeperMcpHttpHandler(
    options({
      verifier: {
        verifyAccessToken: async () => {
          verified++;
          return authInfo();
        },
      },
    }),
  );
  const resource = await handler.fetch(
    request("/.well-known/oauth-protected-resource/mcp"),
  );
  assert.equal(resource.status, 200);
  assert.deepEqual(await resource.json(), {
    resource: RESOURCE.href,
    authorization_servers: [OAUTH.issuer],
    scopes_supported: ["daykeeper.tenants:read"],
    resource_name: "Daykeeper MCP",
  });
  const authorization = await handler.fetch(
    request("/.well-known/oauth-authorization-server"),
  );
  assert.equal(authorization.status, 200);
  assert.deepEqual(await authorization.json(), OAUTH);
  const wrongHost = await handler.fetch(
    new Request(
      "https://evil.example.test/.well-known/oauth-protected-resource/mcp",
      { headers: { host: "evil.example.test" } },
    ),
  );
  assert.equal(wrongHost.status, 403);
  assert.equal(verified, 0);
  await handler.close();
});

test("strict Origin and Bearer syntax fail before verifier or principal resolution", async () => {
  let verified = 0;
  let resolved = 0;
  const verifier: DaykeeperMcpTokenVerifier = {
    verifyAccessToken: async (token) => {
      verified++;
      return authInfo(token);
    },
  };
  const handler = createDaykeeperMcpHttpHandler(
    options({
      verifier,
      resolvePrincipal: async () => {
        resolved++;
        return principal();
      },
    }),
  );
  const preflight = await handler.fetch(
    request("/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://console.example.test",
        "access-control-request-headers": "mcp-method, mcp-name",
      },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://console.example.test",
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /mcp-method, mcp-name/,
  );
  const wrongOrigin = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: {
          origin: "https://console.example.test:444",
          "content-type": "application/json",
        },
        body: "{}",
      },
      true,
    ),
  );
  assert.equal(wrongOrigin.status, 403);
  const malformed = await handler.fetch(
    request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP_TOKEN} extra`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(malformed.status, 401);
  const missing = await handler.fetch(
    request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(missing.status, 401);
  assert.match(
    missing.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  assert.equal(verified, 0);
  assert.equal(resolved, 0);
  const lowerCaseScheme = await handler.fetch(
    request("/mcp", {
      method: "POST",
      headers: {
        authorization: `bearer ${MCP_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.notEqual(lowerCaseScheme.status, 401);
  assert.equal(verified, 1);
  assert.equal(resolved, 1);
  await handler.close();
});

test("the MCP token is audience-bound and cannot be passed through downstream", async () => {
  let resolved = 0;
  const wrongAudience = createDaykeeperMcpHttpHandler(
    options({
      verifier: {
        verifyAccessToken: async (token) =>
          authInfo(token, new URL("https://mcp.example.test/other")),
      },
      resolvePrincipal: async () => {
        resolved++;
        return principal();
      },
    }),
  );
  const rejected = await wrongAudience.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      true,
    ),
  );
  assert.equal(rejected.status, 401);
  assert.equal(resolved, 0);
  await wrongAudience.close();

  const passthrough = createDaykeeperMcpHttpHandler(
    options({
      resolvePrincipal: async () =>
        principal({
          daykeeper: {
            baseUrl: BASE_URL,
            accessToken: MCP_TOKEN,
            scopes: ["daykeeper.tenants:read"],
          },
        }),
    }),
  );
  const refused = await passthrough.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      true,
    ),
  );
  assert.equal(refused.status, 503);
  assert(!JSON.stringify(await refused.json()).includes(MCP_TOKEN));
  await passthrough.close();
});

test("non-finite, expired and excessively long MCP bearer lifetimes are refused", async () => {
  const now = Math.floor(Date.now() / 1_000);
  for (const expiresAt of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    now - 1,
    now + 3_601,
  ]) {
    let resolved = 0;
    const handler = createDaykeeperMcpHttpHandler(
      options({
        verifier: {
          verifyAccessToken: async (token) =>
            authInfo(token, RESOURCE, "synthetic-client", { expiresAt }),
        },
        resolvePrincipal: async () => {
          resolved++;
          return principal();
        },
      }),
    );
    const response = await handler.fetch(
      request(
        "/mcp",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        true,
      ),
    );
    assert.equal(response.status, 401);
    assert.equal(resolved, 0);
    await handler.close();
  }
});

test("downstream grants are API-pinned, non-elevating and bound to one verified principal", async () => {
  const unsafePrincipals: DaykeeperMcpHttpPrincipal[] = [
    principal({
      daykeeper: {
        baseUrl: "https://other.example.test",
        accessToken: DOWNSTREAM_TOKEN,
        scopes: ["daykeeper.tenants:read"],
      },
    }),
    principal({
      daykeeper: {
        baseUrl: BASE_URL,
        accessToken: DOWNSTREAM_TOKEN,
        scopes: ["daykeeper.accounts:write"],
      },
    }),
    principal({ grantId: "different-grant" }),
    principal({ downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 600 }),
  ];
  for (const unsafe of unsafePrincipals) {
    const handler = createDaykeeperMcpHttpHandler(
      options({ resolvePrincipal: async () => unsafe }),
    );
    const response = await handler.fetch(
      request(
        "/mcp",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        true,
      ),
    );
    assert.equal(response.status, 503);
    assert(!JSON.stringify(await response.json()).includes(DOWNSTREAM_TOKEN));
    await handler.close();
  }

  const secondBearer = "daykeeper_mcp_remote_bearer_second_123456789";
  const shared = createDaykeeperMcpHttpHandler(
    options({
      verifier: {
        verifyAccessToken: async (token) =>
          authInfo(token, RESOURCE, "synthetic-client", {
            extra:
              token === MCP_TOKEN
                ? {
                    daykeeperPrincipalId: "principal-1",
                    daykeeperGrantId: "grant-1",
                  }
                : {
                    daykeeperPrincipalId: "principal-2",
                    daykeeperGrantId: "grant-2",
                  },
          }),
      },
      resolvePrincipal: async (auth) =>
        principal({
          principalId: auth.extra.daykeeperPrincipalId,
          grantId: auth.extra.daykeeperGrantId,
        }),
    }),
  );
  const first = await shared.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      true,
    ),
  );
  assert.notEqual(first.status, 503);
  await first.text();
  const second = await shared.fetch(
    request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondBearer}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(second.status, 503);
  await shared.close();
});

test("the rolling downstream binding cache cannot become a cross-tenant admission limit", async () => {
  const handler = createDaykeeperMcpHttpHandler(
    options({
      verifier: {
        verifyAccessToken: async (token) => {
          const identity = token.slice("daykeeper_mcp_remote_bearer_".length);
          return authInfo(token, RESOURCE, "synthetic-client", {
            extra: {
              daykeeperPrincipalId: `principal-${identity}`,
              daykeeperGrantId: `grant-${identity}`,
            },
          });
        },
      },
      resolvePrincipal: async (auth) => ({
        principalId: auth.extra.daykeeperPrincipalId,
        grantId: auth.extra.daykeeperGrantId,
        downstreamExpiresAt: Math.floor(Date.now() / 1_000) + 120,
        daykeeper: {
          baseUrl: BASE_URL,
          accessToken: `daykeeper_downstream_${auth.extra.daykeeperPrincipalId}_token`,
          scopes: ["daykeeper.tenants:read"],
          fetch: async () => {
            throw new Error("Unexpected downstream request");
          },
        },
      }),
    }),
  );
  // Cross the internal recent-binding capacity with distinct, valid tenants.
  // Each response is fully consumed, so none of these credentials stays active.
  for (let index = 0; index < 4_100; index++) {
    const token = `daykeeper_mcp_remote_bearer_${index.toString().padStart(5, "0")}`;
    const response = await handler.fetch(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.notEqual(response.status, 503, `tenant ${index} was admitted`);
    await response.arrayBuffer();
  }
  await handler.close();
});

test("declared and actual request bytes are bounded", async () => {
  let verified = 0;
  const handler = createDaykeeperMcpHttpHandler(
    options({
      maxRequestBytes: 1_024,
      verifier: {
        verifyAccessToken: async (token) => {
          verified++;
          return authInfo(token);
        },
      },
    }),
  );
  const declared = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-length": "1025",
          "content-type": "application/json",
        },
        body: "{}",
      },
      true,
    ),
  );
  assert.equal(declared.status, 413);
  assert.equal(verified, 0);
  const actual = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(1_100) }),
      },
      true,
    ),
  );
  assert.equal(actual.status, 413);
  assert.equal(verified, 1);
  await handler.close();
});

test("authentication has reject-fast capacity that remains held when a verifier ignores cancellation", async () => {
  const started = deferred<void>();
  const verification = deferred<DaykeeperMcpVerifiedAuthInfo>();
  let calls = 0;
  const handler = createDaykeeperMcpHttpHandler(
    options({
      maxConcurrentAuthentications: 1,
      verifier: {
        verifyAccessToken: async (token) => {
          calls++;
          if (calls === 1) {
            started.resolve();
            return verification.promise;
          }
          return authInfo(token);
        },
      },
    }),
  );
  const controller = new AbortController();
  const first = handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      },
      true,
    ),
  );
  await bounded(started.promise);
  const overloaded = await handler.fetch(
    request("/mcp", { method: "POST" }, true),
  );
  assert.equal(overloaded.status, 429);
  assert.equal(calls, 1);
  controller.abort();
  assert.equal((await bounded(first)).status, 499);
  const stillHeld = await handler.fetch(
    request("/mcp", { method: "POST" }, true),
  );
  assert.equal(stillHeld.status, 429);
  verification.resolve(authInfo());
  await new Promise<void>((resolve) => setImmediate(resolve));
  const released = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      true,
    ),
  );
  assert.notEqual(released.status, 429);
  await released.body?.cancel();
  await handler.close();
});

test("non-cooperating request-body cancellation cannot hold an admission slot", async () => {
  const handler = createDaykeeperMcpHttpHandler(
    options({ maxRequestBytes: 1_024 }),
  );
  const response = await bounded(
    handler.fetch(
      request(
        "/mcp",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(2_048));
            },
            cancel() {
              return new Promise<void>(() => undefined);
            },
          }),
          duplex: "half",
        } as RequestInit,
        true,
      ),
    ),
    300,
  );
  assert.equal(response.status, 413);
  await handler.close();
});

test("a verifier may safely reuse one AuthInfo object across concurrent requests", async () => {
  const reused = authInfo();
  const bothResolved = deferred<void>();
  let resolutions = 0;
  const handler = createDaykeeperMcpHttpHandler(
    options({
      maxConcurrentRequestsPerPrincipal: 2,
      verifier: { verifyAccessToken: async () => reused },
      resolvePrincipal: async () => {
        resolutions++;
        if (resolutions === 2) bothResolved.resolve();
        return principal();
      },
    }),
  );
  const controllers = [new AbortController(), new AbortController()];
  const requests = controllers.map((controller) =>
    handler.fetch(
      request(
        "/mcp",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new ReadableStream<Uint8Array>({}),
          signal: controller.signal,
          duplex: "half",
        } as RequestInit,
        true,
      ),
    ),
  );
  await bounded(bothResolved.promise);
  for (const controller of controllers) controller.abort();
  assert.deepEqual(
    await Promise.all(requests.map(async (pending) => (await pending).status)),
    [499, 499],
  );
  await handler.close();
});

test("per-principal admission rejects rather than queues and releases on cancellation", async () => {
  const admitted = deferred<void>();
  let resolutions = 0;
  const handler = createDaykeeperMcpHttpHandler(
    options({
      maxConcurrentRequestsPerPrincipal: 1,
      requestReadTimeoutMs: 1_000,
      resolvePrincipal: async () => {
        resolutions++;
        if (resolutions === 1) admitted.resolve();
        return principal();
      },
    }),
  );
  const controller = new AbortController();
  const pending = handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({}),
        signal: controller.signal,
        duplex: "half",
      } as RequestInit,
      true,
    ),
  );
  const first = pending;
  await bounded(admitted.promise);
  const competing = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      true,
    ),
  );
  assert.equal(competing.status, 429);
  controller.abort();
  assert.equal((await bounded(first)).status, 499);
  const afterCancellation = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      true,
    ),
  );
  assert.notEqual(afterCancellation.status, 429);
  await handler.close();
});

test("MCP responses are bounded even when Content-Length is absent", async () => {
  const handler = createDaykeeperMcpHttpHandler(
    options({ maxResponseBytes: 1_024 }),
  );
  const response = await handler.fetch(
    request(
      "/mcp",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      },
      true,
    ),
  );
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), /exceeded its size limit/);
  await handler.close();
});

test("response streams hold admission until consumed or cancelled", async () => {
  const handler = createDaykeeperMcpHttpHandler(
    options({ maxConcurrentRequestsPerPrincipal: 1 }),
  );
  const toolsList = () =>
    request(
      "/mcp",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      },
      true,
    );
  const first = await handler.fetch(toolsList());
  assert.equal(first.status, 200);
  const whileOpen = await handler.fetch(toolsList());
  assert.equal(whileOpen.status, 429);
  await first.body?.cancel();
  const afterCancel = await handler.fetch(toolsList());
  assert.notEqual(afterCancel.status, 429);
  await afterCancel.body?.cancel();
  await handler.close();
});

test("official modern HTTP client sees the same tools and hosted runtime metadata", async (context) => {
  const handler = createDaykeeperMcpHttpHandler(options());
  const transport = new StreamableHTTPClientTransport(RESOURCE, {
    authProvider: { token: async () => MCP_TOKEN },
    fetch: async (input, init) => {
      const incoming = new Request(input, init);
      const headers = new Headers(incoming.headers);
      headers.set("host", RESOURCE.hostname);
      return handler.fetch(new Request(incoming, { headers }));
    },
  });
  const client = new Client(
    { name: "daykeeper-http-test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  context.after(async () => {
    await client.close();
    await handler.close();
  });
  await client.connect(transport, { timeout: 3_000 });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  const capabilities = await client.readResource({
    uri: "daykeeper://adapter/capabilities",
  });
  const content = capabilities.contents[0];
  assert(content && "text" in content);
  const metadata = JSON.parse(content.text) as Record<string, unknown>;
  assert.equal(metadata.transport, "streamable_http");
  assert.equal(metadata.hostedOAuth, true);
  assert.deepEqual(metadata.http, {
    maximumConcurrentRequests: MAX_HTTP_CONCURRENT_REQUESTS,
    maximumConcurrentAuthentications: MAX_HTTP_CONCURRENT_AUTHENTICATIONS,
    maximumConcurrentRequestsPerPrincipal:
      MAX_HTTP_CONCURRENT_REQUESTS_PER_PRINCIPAL,
    maximumRequestBytes: MAX_HTTP_REQUEST_BYTES,
    maximumResponseBytes: MAX_HTTP_RESPONSE_BYTES,
    requestReadTimeoutMs: MAX_HTTP_REQUEST_READ_MS,
    responseReadTimeoutMs: MAX_HTTP_RESPONSE_READ_MS,
    authenticationTimeoutMs: MAX_HTTP_AUTHENTICATION_MS,
  });
  assert(!JSON.stringify(metadata).includes(MCP_TOKEN));
  assert(!JSON.stringify(metadata).includes(DOWNSTREAM_TOKEN));
});

test("close stops MCP traffic without hiding OAuth discovery", async () => {
  const handler = createDaykeeperMcpHttpHandler(options());
  await handler.close();
  const stopped = await handler.fetch(
    request("/mcp", { method: "POST" }, true),
  );
  assert.equal(stopped.status, 503);
  const discovery = await handler.fetch(
    request("/.well-known/oauth-protected-resource/mcp"),
  );
  assert.equal(discovery.status, 200);
});
