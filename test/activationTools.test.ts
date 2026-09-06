import assert from "node:assert/strict";
import { test } from "node:test";
import { readEnvironment, validateOptions } from "../src/config.ts";
import { toolCatalog, toolDefinitions } from "../src/tools.ts";
import { createDaykeeperMcpServer } from "../src/index.ts";
import {
  sdkSupportsActivationTools,
  assertActivationSdk,
} from "../src/sdkActivation.ts";
import {
  defaults,
  harness,
  api,
  envelope,
  TENANT,
  TOKEN,
  BASE_URL,
} from "./helpers.ts";

const intent = "activation-intent-0001";
const receipt = {
  activationId: "11111111-1111-4111-8111-111111111111",
  tenantId: TENANT,
  channelId: "22222222-2222-4222-8222-222222222222",
  intent,
  state: "active",
  createdAt: 1800000000,
  revokedAt: null,
  replayed: false,
};
const names = [
  "daykeeper_inbox_activations_create",
  "daykeeper_inbox_activations_get",
  "daykeeper_inbox_activations_revoke",
];

test("activation has an independent opt-in and mutations need their own gate", () => {
  assert.equal(validateOptions(defaults).enableActivationTools, false);
  const revoke = toolDefinitions.find(
    (entry) => entry.metadata.name === names[2],
  )!;
  assert.equal(revoke.metadata.idempotent, true);
  assert.equal(revoke.metadata.destructive, true);
  assert.equal(revoke.metadata.requiresIdempotencyKey, false);
  for (const [enableActivationTools, enableMutations, count] of [
    [false, false, 0],
    [false, true, 0],
    [true, false, 1],
    [true, true, 3],
  ] as const) {
    const catalog = toolCatalog(
      validateOptions({ ...defaults, enableActivationTools, enableMutations }),
    );
    assert.equal(
      catalog.filter((entry) => names.includes(entry.name) && entry.enabled)
        .length,
      count,
    );
  }
  assert.equal(
    readEnvironment({
      DAYKEEPER_API_URL: BASE_URL,
      DAYKEEPER_API_KEY: TOKEN,
      DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS: "true",
    }).enableActivationTools,
    true,
  );
  assert.throws(
    () =>
      readEnvironment({
        DAYKEEPER_API_URL: BASE_URL,
        DAYKEEPER_API_KEY: TOKEN,
        DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS: "1",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
});

test("activation SDK probe is separate from older inbox support and performs no calls", () => {
  let calls = 0;
  const work = async () => {
    calls++;
    return receipt;
  };
  const current = {
    inboxActivations: { create: work, get: work, revoke: work },
  };
  assert.equal(sdkSupportsActivationTools(current), true);
  for (const value of [
    {},
    { inboxes: { get: work } },
    { inboxActivations: { get: work, create: work } },
  ]) {
    assert.equal(sdkSupportsActivationTools(value), false);
    assert.throws(() => assertActivationSdk(value), { code: "SDK_TOO_OLD" });
  }
  assert.equal(calls, 0);
  if (!sdkSupportsActivationTools()) {
    assert.throws(
      () =>
        createDaykeeperMcpServer({
          ...defaults,
          enableActivationTools: true,
          fetch: async () => {
            calls++;
            return api(receipt);
          },
        }),
      { code: "SDK_TOO_OLD" },
    );
    assert.equal(calls, 0);
  }
});

test("strict activation inputs fail before SDK dispatch", () => {
  let calls = 0;
  const work = async () => {
    calls++;
    return receipt;
  };
  const client = {
    inboxActivations: { create: work, get: work, revoke: work },
  } as never;
  for (const name of names) {
    const tool = toolDefinitions.find((entry) => entry.metadata.name === name)!;
    const selector = name.endsWith("create")
      ? { idempotencyKey: intent }
      : { intent };
    for (const input of [
      { tenantId: "../foreign", ...selector },
      { tenantId: TENANT, ...selector, installationId: "attacker" },
      { tenantId: TENANT },
    ])
      assert.throws(() => tool.dispatch(client, input));
  }
  assert.equal(calls, 0);
});

test("activation receipts reject internal fields, mismatched selectors and impossible state", async () => {
  const tool = toolDefinitions.find(
    (entry) => entry.metadata.name === names[1],
  )!;
  for (const row of [
    { ...receipt, runtimeLoginOid: 123 },
    { ...receipt, tenantId: "33333333-3333-4333-8333-333333333333" },
    { ...receipt, intent: "foreign-activation-intent" },
    { ...receipt, createdAt: "1800000000" },
    { ...receipt, state: "revoked", revokedAt: null },
    { ...receipt, state: "active", revokedAt: 1800000001 },
    { ...receipt, state: "revoked", revokedAt: 1 },
    { ...receipt, createdAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const client = {
      inboxActivations: {
        create: async () => row,
        get: async () => row,
        revoke: async () => row,
      },
    } as never;
    await assert.rejects(tool.dispatch(client, { tenantId: TENANT, intent }), {
      code: "INVALID_API_RESPONSE",
    });
  }
});

test("activation dispatch forwards the exact cancellation signal", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const work = async (
    _tenant: string,
    _intent: string,
    options: { signal?: AbortSignal },
  ) => {
    observed = options.signal;
    return receipt;
  };
  const client = {
    inboxActivations: { create: async () => receipt, get: work, revoke: work },
  } as never;
  const tool = toolDefinitions.find(
    (entry) => entry.metadata.name === names[1],
  )!;
  await tool.dispatch(client, { tenantId: TENANT, intent }, controller.signal);
  assert.equal(observed, controller.signal);
});

for (const operation of ["create", "get", "revoke"] as const) {
  test(`candidate SDK: activation ${operation}`, async (t) => {
    if (!sdkSupportsActivationTools()) {
      t.skip("installed SDK lacks activation support");
      return;
    }
    let calls = 0;
    const client = await harness(t, {
      enableActivationTools: true,
      enableMutations: true,
      scopes: ["daykeeper.accounts:read", "daykeeper.accounts:write"],
      fetch: async (url, init) => {
        calls++;
        const suffix =
          operation === "create"
            ? ""
            : `/${intent}${operation === "revoke" ? "/revoke" : ""}`;
        assert.equal(
          String(url),
          `${BASE_URL}/v1/tenants/${TENANT}/inbox-activations${suffix}`,
        );
        assert.equal(init?.method, operation === "get" ? "GET" : "POST");
        assert.equal(init?.body, operation === "get" ? undefined : "{}");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${TOKEN}`,
        );
        assert.equal(
          new Headers(init?.headers).get("idempotency-key"),
          operation === "create" ? intent : null,
        );
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        assert(init?.signal instanceof AbortSignal);
        return api(
          operation === "revoke"
            ? { ...receipt, state: "revoked", revokedAt: receipt.createdAt + 1 }
            : receipt,
        );
      },
    });
    const arguments_ = {
      tenantId: TENANT,
      ...(operation === "create" ? { idempotencyKey: intent } : { intent }),
    };
    const result = envelope(
      await client.callTool({
        name: `daykeeper_inbox_activations_${operation}`,
        arguments: arguments_,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.deepEqual(
      Object.keys(result.data as object).sort(),
      Object.keys(receipt).sort(),
    );
    assert.equal(
      (result.data as typeof receipt).state,
      operation === "revoke" ? "revoked" : "active",
    );
  });
}

test("candidate SDK: activation writes require declared scopes and do not retry uncertain outcomes", async (t) => {
  if (!sdkSupportsActivationTools()) {
    t.skip("installed SDK lacks activation support");
    return;
  }
  let calls = 0;
  for (const scopes of [undefined, [], ["daykeeper.accounts:read"]]) {
    const client = await harness(t, {
      enableActivationTools: true,
      enableMutations: true,
      scopes,
      fetch: async () => {
        calls++;
        return api(receipt);
      },
    });
    const result = envelope(
      await client.callTool({
        name: names[0],
        arguments: { tenantId: TENANT, idempotencyKey: intent },
      }),
    );
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
  const client = await harness(t, {
    enableActivationTools: true,
    enableMutations: true,
    scopes: ["daykeeper.accounts:write"],
    fetch: async () => {
      calls++;
      throw new Error("lost response");
    },
  });
  const result = envelope(
    await client.callTool({
      name: names[0],
      arguments: { tenantId: TENANT, idempotencyKey: intent },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert(
    result.error?.nextActions.includes(
      "inspect_activation_with_original_intent",
    ),
  );
});
