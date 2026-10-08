import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDaykeeperIntrospectionVerifier,
  DaykeeperMcpVerifierUnavailableError,
  type DaykeeperIntrospectionVerifierOptions,
} from "../src/index.ts";

const SECRET = "introspection-secret-0123456789abcdef";
const TOKEN = "dk_oat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RESOURCE = "https://api.mydaykeeper.com/mcp";
const URL_ = new URL("http://daykeeper-api:4100/oauth/introspect");
const context = () => ({
  signal: new AbortController().signal,
  resourceServerUrl: new URL(RESOURCE),
});

function active(now: number, overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    scope: "daykeeper.accounts:read daykeeper.conversations:read",
    exp: now + 1_800,
    client_id: "https://chatgpt.com/oauth/client.json",
    resource: RESOURCE,
    daykeeper_principal_id: "user-1",
    daykeeper_grant_id: "conn-1",
    token_type: "Bearer",
    iss: "https://api.mydaykeeper.com",
    ...overrides,
  };
}

function verifier(
  answer: (request: Request) => Response | Promise<Response>,
  options: Partial<DaykeeperIntrospectionVerifierOptions> = {},
) {
  const requests: Request[] = [];
  const instance = createDaykeeperIntrospectionVerifier({
    introspectionUrl: URL_,
    clientSecret: SECRET,
    internalHttpHostnames: ["daykeeper-api"],
    issuer: "https://api.mydaykeeper.com",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return answer(request);
    },
    ...options,
  });
  return { instance, requests };
}

test("an active introspection result maps to verified AuthInfo", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const { instance, requests } = verifier(() => Response.json(active(now)));
  const auth = await instance.verifyAccessToken(TOKEN, context());
  assert.equal(auth.token, TOKEN);
  assert.equal(auth.clientId, "https://chatgpt.com/oauth/client.json");
  assert.deepEqual(auth.scopes, [
    "daykeeper.accounts:read",
    "daykeeper.conversations:read",
  ]);
  assert.equal(auth.expiresAt, now + 1_800);
  assert.equal(auth.resource.href, RESOURCE);
  assert.deepEqual(auth.extra, {
    daykeeperPrincipalId: "user-1",
    daykeeperGrantId: "conn-1",
  });
  const request = requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.url, URL_.href);
  assert.equal(request.headers.get("authorization"), `Bearer ${SECRET}`);
  assert.equal(
    request.headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assert.equal(await request.text(), `token=${TOKEN}`);
});

test("inactive, malformed and mismatched answers are invalid tokens, not outages", async () => {
  const now = Math.floor(Date.now() / 1_000);
  for (const body of [
    { active: false },
    { active: "true" },
    {},
    active(now, { exp: now - 1 }),
    active(now, { exp: "soon" }),
    active(now, { scope: 7 }),
    active(now, { daykeeper_principal_id: undefined }),
    active(now, { daykeeper_grant_id: "" }),
    active(now, { resource: "not a url" }),
    active(now, { iss: "https://evil.example.test" }),
    active(now, { token_type: "refresh_token" }),
    active(now, { nbf: now + 600 }),
    active(now, { scope: "a a" }),
    active(now, { client_id: " padded" }),
  ]) {
    const { instance } = verifier(() => Response.json(body));
    await assert.rejects(
      instance.verifyAccessToken(TOKEN, context()),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof DaykeeperMcpVerifierUnavailableError),
      JSON.stringify(body),
    );
  }
});

test("timeouts, failures, odd statuses and oversized answers mean verification is unavailable", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const cases: Array<
    [string, (request: Request) => Response | Promise<Response>]
  > = [
    [
      "network",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["401 from introspection", () => new Response("no", { status: 401 })],
    ["500", () => Response.json({ error: "boom" }, { status: 500 })],
    [
      "not json",
      () =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
    ],
    [
      "invalid json",
      () =>
        new Response("{", {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "too large",
      () => Response.json({ ...active(now), padding: "x".repeat(20_000) }),
    ],
    [
      "stalled body",
      () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "slow",
      (request) =>
        new Promise<Response>((_, reject) =>
          request.signal.addEventListener("abort", () =>
            reject(request.signal.reason),
          ),
        ),
    ],
  ];
  for (const [label, answer] of cases) {
    const { instance } = verifier(answer, { timeoutMs: 500 });
    await assert.rejects(
      instance.verifyAccessToken(TOKEN, context()),
      DaykeeperMcpVerifierUnavailableError,
      label,
    );
  }
});

test("positive results are cached briefly and never past expiry; negatives are not cached", async () => {
  let clock = 1_000_000_000_000;
  const now = () => Math.floor(clock / 1_000);
  let exp = now() + 1_800;
  let answer: unknown = active(now(), { exp });
  const { instance, requests } = verifier(() => Response.json(answer), {
    now: () => clock,
  });
  await instance.verifyAccessToken(TOKEN, context());
  await instance.verifyAccessToken(TOKEN, context());
  assert.equal(requests.length, 1);
  clock += 29_000;
  await instance.verifyAccessToken(TOKEN, context());
  assert.equal(requests.length, 1);
  clock += 2_000;
  answer = { active: false };
  await assert.rejects(instance.verifyAccessToken(TOKEN, context()));
  await assert.rejects(instance.verifyAccessToken(TOKEN, context()));
  assert.equal(requests.length, 3);

  // A token expiring in 5 s is cached for at most those 5 s.
  exp = now() + 5;
  answer = active(now(), { exp });
  await instance.verifyAccessToken(TOKEN, context());
  clock += 6_000;
  answer = { active: false };
  await assert.rejects(instance.verifyAccessToken(TOKEN, context()));
  assert.equal(requests.length, 5);

  // A different token is never served from another token's entry.
  answer = active(now());
  await instance.verifyAccessToken(`${TOKEN}B`, context());
  assert.equal(requests.length, 6);
});

test("caching can be disabled", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const { instance, requests } = verifier(() => Response.json(active(now)), {
    cacheSeconds: 0,
  });
  await instance.verifyAccessToken(TOKEN, context());
  await instance.verifyAccessToken(TOKEN, context());
  assert.equal(requests.length, 2);
});

test("configuration allows plain HTTP only to loopback or an allowlisted internal host", () => {
  const base: DaykeeperIntrospectionVerifierOptions = {
    introspectionUrl: URL_,
    clientSecret: SECRET,
    internalHttpHostnames: ["daykeeper-api"],
  };
  assert.doesNotThrow(() => createDaykeeperIntrospectionVerifier(base));
  assert.doesNotThrow(() =>
    createDaykeeperIntrospectionVerifier({
      ...base,
      introspectionUrl: new URL("https://api.example.test/oauth/introspect"),
      internalHttpHostnames: undefined,
    }),
  );
  for (const candidate of [
    { internalHttpHostnames: undefined },
    { internalHttpHostnames: ["other-api"] },
    { internalHttpHostnames: ["10.0.0.4"] },
    { introspectionUrl: new URL("http://10.0.0.4/oauth/introspect") },
    { introspectionUrl: new URL("http://daykeeper-api:4100/x?y=1") },
    { introspectionUrl: new URL("http://u:p@daykeeper-api/x") },
    { clientSecret: "short" },
    { clientSecret: `${SECRET} with space` },
    { timeoutMs: 60_000 },
    { cacheSeconds: 31 },
    { issuer: "http://api.mydaykeeper.com" },
  ])
    assert.throws(
      () => createDaykeeperIntrospectionVerifier({ ...base, ...candidate }),
      /Invalid Daykeeper introspection configuration/,
      JSON.stringify(candidate),
    );
});

test("an error never carries the token or the client secret", async () => {
  const { instance } = verifier(() => new Response("x", { status: 500 }));
  await assert.rejects(
    instance.verifyAccessToken(TOKEN, context()),
    (error) => {
      const text = `${String(error)} ${JSON.stringify(error)}`;
      assert(!text.includes(TOKEN));
      assert(!text.includes(SECRET));
      return true;
    },
  );
});
