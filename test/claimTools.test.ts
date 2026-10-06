import assert from "node:assert/strict";
import { test } from "node:test";
import { readEnvironment, validateOptions } from "../src/config.ts";
import { toolCatalog, toolDefinitions } from "../src/tools.ts";
import { assertClaimSdk, sdkSupportsClaimTools } from "../src/sdkClaims.ts";
import {
  defaults,
  harness,
  api,
  envelope,
  TOKEN,
  BASE_URL,
} from "./helpers.ts";

const CLAIM = "66666666-6666-4666-8666-666666666666";
const ORGANIZATION = "77777777-7777-4777-8777-777777777777";
const KEY = "claim-sam-acme-000001";
const INVITE = `dk_invite_${"a".repeat(43)}`;
const claim = {
  id: CLAIM,
  organizationId: ORGANIZATION,
  email: "sam@acme.example",
  role: "owner",
  state: "pending",
  createdAt: "2026-10-06T08:00:00.000Z",
  expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
  acceptedAt: null,
  revokedAt: null,
};
const created = {
  claim,
  token: INVITE,
  claimUrl: `https://app.example.test/claim#token=${INVITE}`,
  replayed: false,
};
const names = [
  "daykeeper_workspace_claims_create",
  "daykeeper_workspace_claims_list",
  "daykeeper_workspace_claims_revoke",
];
const tool = (name: string) =>
  toolDefinitions.find((entry) => entry.metadata.name === name)!;

test("claim tools have their own opt-in, and writes need the mutation gate", () => {
  assert.equal(validateOptions(defaults).enableClaimTools, false);
  for (const [enableClaimTools, enableMutations, count] of [
    [false, false, 0],
    [false, true, 0],
    [true, false, 1],
    [true, true, 3],
  ] as const) {
    const catalog = toolCatalog(
      validateOptions({ ...defaults, enableClaimTools, enableMutations }),
    );
    assert.equal(
      catalog.filter((entry) => names.includes(entry.name) && entry.enabled)
        .length,
      count,
    );
  }
  assert.equal(tool(names[0]!).metadata.requiresIdempotencyKey, true);
  assert.equal(tool(names[2]!).metadata.destructive, true);
  assert.equal(tool(names[2]!).metadata.requiresIdempotencyKey, false);
  assert.equal(
    readEnvironment({
      DAYKEEPER_API_URL: BASE_URL,
      DAYKEEPER_API_KEY: TOKEN,
      DAYKEEPER_MCP_ENABLE_CLAIM_TOOLS: "true",
    }).enableClaimTools,
    true,
  );
  assert.throws(
    () =>
      readEnvironment({
        DAYKEEPER_API_URL: BASE_URL,
        DAYKEEPER_API_KEY: TOKEN,
        DAYKEEPER_MCP_ENABLE_CLAIM_TOOLS: "yes",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
});

test("the claim SDK probe needs create, list and revoke and never dispatches", () => {
  let calls = 0;
  const work = async () => {
    calls++;
    return created;
  };
  assert.equal(
    sdkSupportsClaimTools({
      workspaceClaims: { create: work, list: work, revoke: work },
    }),
    true,
  );
  for (const value of [{}, { workspaceClaims: { create: work, list: work } }]) {
    assert.equal(sdkSupportsClaimTools(value), false);
    assert.throws(() => assertClaimSdk(value), { code: "SDK_TOO_OLD" });
  }
  assert.equal(calls, 0);
  // The pinned SDK (0.3.0) ships workspaceClaims.
  assert.equal(sdkSupportsClaimTools(), true);
});

test("a new claim returns the link and a message to relay; a replay returns neither link nor token", async () => {
  const seen: unknown[][] = [];
  const client = {
    workspaceClaims: {
      create: async (...args: unknown[]) => {
        seen.push(args);
        return created;
      },
      list: async () => ({ items: [claim] }),
      revoke: async () => ({ ...claim, state: "revoked" }),
    },
  } as never;
  const result = (await tool(names[0]!).dispatch(client, {
    email: "  Sam@Acme.Example ",
    idempotencyKey: KEY,
  })) as Record<string, any>;
  // Folded before sending: the platform rejects rather than folds.
  assert.deepEqual((seen[0] as unknown[])[0], { email: "sam@acme.example" });
  assert.equal(
    ((seen[0] as unknown[])[1] as { idempotencyKey: string }).idempotencyKey,
    KEY,
  );
  assert.equal(result.claimUrl, created.claimUrl);
  assert.equal(result.replayed, false);
  assert.equal(result.emailed, false);
  assert.equal("token" in result, false);
  assert.equal("organizationId" in result.claim, false);
  assert.match(result.message, /^Send this link to sam@acme\.example\./);
  assert.match(result.message, /expires in 72 hours \(on /);

  const emailed = (await tool(names[0]!).dispatch(
    {
      workspaceClaims: {
        create: async () => ({ ...created, emailed: true }),
        list: async () => ({ items: [] }),
        revoke: async () => claim,
      },
    } as never,
    { email: "sam@acme.example", idempotencyKey: KEY },
  )) as Record<string, any>;
  assert.equal(emailed.emailed, true);
  assert.match(emailed.message, /^Daykeeper emailed this link/);

  const replay = (await tool(names[0]!).dispatch(
    {
      workspaceClaims: {
        create: async () => ({
          claim,
          token: null,
          claimUrl: null,
          replayed: true,
        }),
        list: async () => ({ items: [] }),
        revoke: async () => claim,
      },
    } as never,
    { email: "sam@acme.example", idempotencyKey: KEY },
  )) as Record<string, any>;
  assert.equal(replay.claimUrl, null);
  assert.match(replay.message, /already waiting/);
  assert.match(replay.message, /daykeeper_workspace_claims_revoke/);
});

test("claim inputs and responses are strict", async () => {
  let calls = 0;
  const work = async () => {
    calls++;
    return created;
  };
  const client = {
    workspaceClaims: { create: work, list: work, revoke: work },
  } as never;
  for (const input of [
    { email: "not-an-address", idempotencyKey: KEY },
    { email: "sam@acme.example" },
    { email: "sam@acme.example", idempotencyKey: "short" },
    { email: "sam@acme.example", idempotencyKey: KEY, role: "member" },
  ])
    assert.throws(() => tool(names[0]!).dispatch(client, input));
  assert.throws(() => tool(names[2]!).dispatch(client, { claimId: "../x" }));
  assert.equal(calls, 0);

  for (const response of [
    { ...created, claimUrl: "http://app.example.test/claim#token=x" },
    { ...created, claimUrl: `https://evil.example.test/?token=${INVITE}` },
    { ...created, claim: { ...claim, email: "other@acme.example" } },
    { ...created, claim: { ...claim, role: "member" } },
    { ...created, replayed: true },
  ]) {
    await assert.rejects(
      tool(names[0]!).dispatch(
        {
          workspaceClaims: {
            create: async () => response,
            list: work,
            revoke: work,
          },
        } as never,
        { email: "sam@acme.example", idempotencyKey: KEY },
      ),
      { code: "INVALID_API_RESPONSE" },
      JSON.stringify(response),
    );
  }
});

test("installed SDK: claim create, list and revoke go to the management API under the configured key", async (t) => {
  const requests: {
    url: string;
    method?: string;
    body?: unknown;
    key: string | null;
  }[] = [];
  const client = await harness(t, {
    enableClaimTools: true,
    enableMutations: true,
    scopes: ["daykeeper.accounts:read", "daykeeper.accounts:write"],
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method,
        body: init?.body,
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${TOKEN}`,
      );
      if (String(url).endsWith("/revoke"))
        return api({ ...claim, state: "revoked", revokedAt: claim.createdAt });
      if (init?.method === "POST") return api(created, 201);
      return api({ items: [claim] });
    },
  });
  const made = envelope(
    await client.callTool({
      name: names[0]!,
      arguments: { email: "sam@acme.example", idempotencyKey: KEY },
    }),
  );
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal((made.data as { claimUrl: string }).claimUrl, created.claimUrl);
  const listed = envelope(
    await client.callTool({ name: names[1]!, arguments: {} }),
  );
  assert.equal(listed.ok, true);
  assert.deepEqual(
    (listed.data as { claims: { id: string }[] }).claims.map((item) => item.id),
    [CLAIM],
  );
  assert(!JSON.stringify(listed).includes("dk_invite_"));
  const revoked = envelope(
    await client.callTool({ name: names[2]!, arguments: { claimId: CLAIM } }),
  );
  assert.equal(revoked.ok, true);
  assert.deepEqual(
    requests.map((request) => [
      request.method ?? "GET",
      request.url,
      request.key,
    ]),
    [
      ["POST", `${BASE_URL}/v1/workspace-claims`, KEY],
      ["GET", `${BASE_URL}/v1/workspace-claims`, null],
      ["POST", `${BASE_URL}/v1/workspace-claims/${CLAIM}/revoke`, null],
    ],
  );
  assert.equal(
    requests[0]!.body,
    JSON.stringify({ email: "sam@acme.example" }),
  );
});

test("installed SDK: an uncertain claim says to list claims and reuse the key", async (t) => {
  let calls = 0;
  const client = await harness(t, {
    enableClaimTools: true,
    enableMutations: true,
    scopes: ["daykeeper.accounts:write"],
    fetch: async () => {
      calls++;
      throw new Error("lost response");
    },
  });
  const result = envelope(
    await client.callTool({
      name: names[0]!,
      arguments: { email: "sam@acme.example", idempotencyKey: KEY },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert(result.error?.nextActions.includes("list_workspace_claims"));
  assert(result.error?.nextActions.includes("reuse_original_idempotency_key"));
});
