import assert from "node:assert/strict";
import { test } from "node:test";
import { readEnvironment, validateOptions } from "../src/config.ts";
import { createDaykeeperMcpServer } from "../src/index.ts";
import {
  assertFlowWriteSdk,
  REQUIRED_FLOW_WRITE_SDK_VERSION,
  sdkSupportsFlowWrites,
} from "../src/sdkFlows.ts";
import {
  toolCatalog,
  toolDefinitions,
  type ToolMetadata,
} from "../src/tools.ts";
import type { DaykeeperClient } from "@skyporch/daykeeper";
import type { FlowMutationResultShim } from "../src/sdkFlows.ts";
import { createExecutor } from "../src/transport.ts";
import {
  api,
  BASE_URL,
  defaults,
  envelope,
  FLOW,
  harness,
  KEY,
  TENANT,
  TOKEN,
} from "./helpers.ts";

const WRITE_SCOPES = ["daykeeper.flows:write", "daykeeper.flows:publish"];
const FLOW_WRITE_TOOLS = [
  "daykeeper_flows_create",
  "daykeeper_flow_versions_create",
  "daykeeper_flow_versions_publish",
];
const DEFINITION = {
  schemaVersion: "2026-08-01",
  trigger: { event: "conversation.created", channel: "email" },
  conditions: [
    { field: "message.text", operator: "contains", value: "refund" },
  ],
  actions: [{ id: "handoff-1", type: "handoff", target: "human" }],
};
const supported = sdkSupportsFlowWrites();
// The published SDK still exposes key-less flow mutations, so the dispatching
// cases only run against a candidate SDK that carries an idempotency key.
const dispatches = supported
  ? {}
  : {
      skip: `Requires @skyporch/daykeeper ${REQUIRED_FLOW_WRITE_SDK_VERSION} or newer`,
    };

const enabled = {
  enableMutations: true,
  enableFlowWrites: true,
  scopes: WRITE_SCOPES,
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

function metadata(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    name: "daykeeper_flows_create",
    description: "Test flow write",
    effect: "mutation",
    scopes: ["daykeeper.flows:write"],
    idempotent: true,
    destructive: false,
    requiresIdempotencyKey: true,
    requiresFlowWrites: true,
    ...overrides,
  };
}

for (const [enableMutations, enableFlowWrites, enabled] of [
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, true],
] as const) {
  test(`flow writes need both gates: mutations=${enableMutations}, flowWrites=${enableFlowWrites}`, () => {
    const catalog = toolCatalog(
      validateOptions({
        ...defaults,
        enableMutations,
        enableFlowWrites,
        scopes: WRITE_SCOPES,
      }),
    );
    for (const name of FLOW_WRITE_TOOLS) {
      const entry = catalog.find((tool) => tool.name === name);
      assert(entry, `Missing catalog entry: ${name}`);
      assert.equal(entry.enabled, enabled);
      assert.equal(entry.effect, "mutation");
      assert.equal(entry.requiresIdempotencyKey, true);
      // Every write declares the one exact scope it needs.
      assert.deepEqual(
        entry.scopes,
        name === "daykeeper_flow_versions_publish"
          ? ["daykeeper.flows:publish"]
          : ["daykeeper.flows:write"],
      );
      assert.match(entry.description, /reuse/i);
      assert.match(entry.description, /idempotencyKey/);
    }
    // The generic mutation gate keeps working on its own.
    assert.equal(
      catalog.find((tool) => tool.name === "daykeeper_tenants_apply")?.enabled,
      enableMutations,
    );
  });
}

test("the flow-write gate and declared scopes are read from the environment", () => {
  const config = validateOptions(
    readEnvironment({
      DAYKEEPER_API_URL: defaults.baseUrl,
      DAYKEEPER_API_KEY: TOKEN,
      DAYKEEPER_MCP_ENABLE_MUTATIONS: "true",
      DAYKEEPER_MCP_ENABLE_FLOW_WRITES: "true",
      DAYKEEPER_MCP_SCOPES: "daykeeper.flows:publish, daykeeper.flows:write",
    }),
  );
  assert.equal(config.enableFlowWrites, true);
  assert.deepEqual(config.scopes, [
    "daykeeper.flows:publish",
    "daykeeper.flows:write",
  ]);
  assert.equal(
    validateOptions({ ...defaults, enableMutations: true }).enableFlowWrites,
    false,
  );
  assert.equal(validateOptions(defaults).scopes, undefined);
  for (const environment of [
    { DAYKEEPER_MCP_ENABLE_FLOW_WRITES: "1" },
    { DAYKEEPER_MCP_ENABLE_FLOW_WRITES: "TRUE" },
    { DAYKEEPER_MCP_SCOPES: "" },
    { DAYKEEPER_MCP_SCOPES: "*" },
    { DAYKEEPER_MCP_SCOPES: "daykeeper.flows:write extra" },
    { DAYKEEPER_MCP_SCOPES: "flows:write" },
  ]) {
    assert.throws(
      () =>
        readEnvironment({
          DAYKEEPER_API_URL: defaults.baseUrl,
          DAYKEEPER_API_KEY: TOKEN,
          ...environment,
        }),
      { code: "INVALID_CONFIGURATION" },
    );
  }
});

test("an SDK without idempotent flow mutations is refused by name and version", () => {
  assert.equal(sdkSupportsFlowWrites({ DaykeeperClient: class {} }), false);
  assert.equal(
    sdkSupportsFlowWrites({ generateIdempotencyKey: () => "key" }),
    true,
  );
  assert.throws(() => assertFlowWriteSdk({ DaykeeperClient: class {} }), {
    code: "SDK_TOO_OLD",
    message: new RegExp(
      `@skyporch/daykeeper ${REQUIRED_FLOW_WRITE_SDK_VERSION}`,
    ),
  });
  assert.doesNotThrow(() =>
    assertFlowWriteSdk({ generateIdempotencyKey: () => "key" }),
  );
});

test("the server refuses to start when the installed SDK cannot carry a key", () => {
  const options = {
    ...defaults,
    enableMutations: true,
    enableFlowWrites: true,
    scopes: WRITE_SCOPES,
  };
  if (supported) {
    const server = createDaykeeperMcpServer(options);
    void server.close();
  } else {
    assert.throws(() => createDaykeeperMcpServer(options), {
      code: "SDK_TOO_OLD",
    });
  }
  // A disabled gate never blocks startup, whatever SDK is installed.
  const readOnly = createDaykeeperMcpServer({ ...defaults });
  void readOnly.close();
});

test("flow writes refuse before dispatch unless the exact scope is declared", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return api({});
  };
  for (const [scopes, code] of [
    [undefined, "SCOPES_NOT_DECLARED"],
    [["daykeeper.flows:read"], "SCOPE_NOT_GRANTED"],
    [["daykeeper.flows:write"], "SCOPE_NOT_GRANTED"],
  ] as const) {
    const config = validateOptions({
      ...defaults,
      enableMutations: true,
      enableFlowWrites: true,
      ...(scopes ? { scopes } : {}),
    });
    const result = envelope(
      await createExecutor(config, transport)(
        metadata({
          name: "daykeeper_flow_versions_publish",
          scopes: ["daykeeper.flows:publish"],
        }),
        {},
        async () => ({}),
        signal(),
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, false);
  }
  assert.equal(calls, 0, "A refused scope must never reach the API");
});

test("a minimal write scope list still allows the inspect path", async (context) => {
  const client = await harness(context, {
    // The declared list holds only write scopes, as it would for a flow-write
    // deployment. Enabling the flow-write gate here would depend on the
    // installed SDK; the read exemption does not.
    enableMutations: true,
    scopes: WRITE_SCOPES,
    fetch: async () => api({ flow: { id: FLOW }, version: { version: 2 } }),
  });
  // Reads are never gated by the declared list: inspecting an uncertain write
  // is exactly what the unknown-outcome guidance asks the model to do.
  for (const inspect of [
    { name: "daykeeper_flows_get", arguments: { flowId: FLOW } },
    {
      name: "daykeeper_flow_versions_get",
      arguments: { flowId: FLOW, version: 2 },
    },
    { name: "daykeeper_flows_list", arguments: {} },
    { name: "daykeeper_tenants_list", arguments: {} },
  ]) {
    const result = envelope(await client.callTool(inspect));
    assert.equal(result.ok, true, `${inspect.name} must not be scope-refused`);
  }
});

test("an undeclared write scope is still refused under the same list", async () => {
  const config = validateOptions({
    ...defaults,
    enableMutations: true,
    scopes: ["daykeeper.flows:write"],
  });
  const result = envelope(
    await createExecutor(config, async () => api({}))(
      metadata({
        name: "daykeeper_tenants_apply",
        scopes: ["daykeeper.provisioning:apply"],
        requiresFlowWrites: false,
      }),
      {},
      async () => ({}),
      signal(),
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SCOPE_NOT_GRANTED");
});

test("an uncertain flow write asks for inspection and the original key", async () => {
  const config = validateOptions({
    ...defaults,
    enableMutations: true,
    enableFlowWrites: true,
    scopes: WRITE_SCOPES,
    timeoutMs: 1_000,
  });
  const result = envelope(
    await createExecutor(config, async () => {
      throw new Error("connection lost after dispatch");
    })(
      metadata(),
      {},
      (client) =>
        client.tenants.apply(
          { planId: TENANT, planVersion: 1 },
          { idempotencyKey: KEY },
        ),
      signal(),
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.deepEqual(result.error?.nextActions, [
    "inspect_resource_before_retry",
    "reuse_original_idempotency_key",
  ]);
});

test("a reused key is a structured error that never suggests a blind new key", async () => {
  const config = validateOptions({
    ...defaults,
    enableMutations: true,
    enableFlowWrites: true,
    scopes: WRITE_SCOPES,
  });
  const result = envelope(
    await createExecutor(config, async () => api({}))(
      metadata(),
      {},
      async () => {
        const { McpAdapterError } = await import("../src/errors.ts");
        throw new McpAdapterError(
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotencyKey was already used for a different request.",
        );
      },
      signal(),
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(result.error?.retryable, false);
  assert.deepEqual(result.error?.nextActions, [
    "inspect_resource_before_retry",
    "use_a_fresh_key_only_for_a_different_request",
  ]);
});

/**
 * A fake in-process SDK with the idempotent flows shape. It runs the real
 * dispatch pipeline, projection and envelope on any installed SDK, so the
 * uncertain-outcome and reused-key paths are covered even while the released
 * SDK still exposes key-less flow mutations. The packed-candidate cases below
 * additionally cover the real HTTP request shape.
 */
interface FlowCall {
  method: string;
  args: readonly unknown[];
  key: string;
}

function fakeSdk(
  behavior: (call: FlowCall) => Promise<FlowMutationResultShim>,
): { client: DaykeeperClient; calls: FlowCall[] } {
  const calls: FlowCall[] = [];
  const record = (call: FlowCall) => {
    calls.push(call);
    return behavior(call);
  };
  return {
    calls,
    client: {
      flows: {
        create: (
          tenantId: string,
          input: unknown,
          options: { idempotencyKey: string },
        ) =>
          record({
            method: "create",
            args: [tenantId, input],
            key: options.idempotencyKey,
          }),
        createVersion: (
          flowId: string,
          input: unknown,
          options: { idempotencyKey: string },
        ) =>
          record({
            method: "createVersion",
            args: [flowId, input],
            key: options.idempotencyKey,
          }),
        publishVersion: (
          flowId: string,
          version: number,
          input: unknown,
          options: { idempotencyKey: string },
        ) =>
          record({
            method: "publishVersion",
            args: [flowId, version, input],
            key: options.idempotencyKey,
          }),
      },
    } as unknown as DaykeeperClient,
  };
}

function result(replayed: boolean): FlowMutationResultShim {
  return {
    flow: {
      id: FLOW,
      tenantId: TENANT,
      slug: "refunds",
      latestVersion: 2,
      // An unknown server field must never reach the caller.
      internalNote: "private-api-detail",
    },
    version: { flowId: FLOW, version: 2, contentHash: "abc" },
    replayed,
  };
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  behavior: (call: FlowCall) => Promise<FlowMutationResultShim>,
) {
  const definition = toolDefinitions.find(
    (tool) => tool.metadata.name === name,
  );
  assert(definition, `Missing tool definition: ${name}`);
  const { client, calls } = fakeSdk(behavior);
  const config = validateOptions({ ...defaults, ...enabled });
  const envelopeResult = envelope(
    await createExecutor(config, async () => api({}))(
      definition.metadata,
      args,
      () => definition.dispatch(client, args),
      signal(),
    ),
  );
  return { result: envelopeResult, calls };
}

const CREATE_INPUT = {
  name: "Refund handoff",
  slug: "refunds",
  definition: DEFINITION,
};

test("each flow write passes the caller's exact key and arguments once", async () => {
  for (const [name, args, expected] of [
    [
      "daykeeper_flows_create",
      { tenantId: TENANT, input: CREATE_INPUT, idempotencyKey: KEY },
      { method: "create", args: [TENANT, CREATE_INPUT] },
    ],
    [
      "daykeeper_flow_versions_create",
      {
        flowId: FLOW,
        input: { expectedLatestVersion: 1, definition: DEFINITION },
        idempotencyKey: KEY,
      },
      {
        method: "createVersion",
        args: [FLOW, { expectedLatestVersion: 1, definition: DEFINITION }],
      },
    ],
    [
      "daykeeper_flow_versions_publish",
      {
        flowId: FLOW,
        version: 2,
        input: { expectedResourceVersion: 3 },
        idempotencyKey: KEY,
      },
      {
        method: "publishVersion",
        args: [FLOW, 2, { expectedResourceVersion: 3 }],
      },
    ],
  ] as const) {
    const { result: envelopeResult, calls } = await dispatch(
      name,
      args as unknown as Record<string, unknown>,
      async () => result(false),
    );
    assert.equal(envelopeResult.ok, true);
    assert.equal(calls.length, 1, "A write must be dispatched exactly once");
    assert.equal(calls[0]?.method, expected.method);
    assert.deepEqual(calls[0]?.args, expected.args);
    // The adapter never mints or rewrites a key.
    assert.equal(calls[0]?.key, KEY);
  }
});

test("an applied write projects identity only", async () => {
  const { result: applied } = await dispatch(
    "daykeeper_flows_create",
    { tenantId: TENANT, input: CREATE_INPUT, idempotencyKey: KEY },
    async () => result(false),
  );
  assert.deepEqual(applied.data, {
    outcome: "applied",
    replayed: false,
    idempotencyKey: KEY,
    flow: {
      id: FLOW,
      tenantId: TENANT,
      slug: "refunds",
      latestVersion: 2,
    },
    version: { flowId: FLOW, version: 2, contentHash: "abc" },
  });
  assert(!JSON.stringify(applied).includes("private-api-detail"));
});

test("a replayed write is reported as replayed, not applied again", async () => {
  const { result: replayed, calls } = await dispatch(
    "daykeeper_flow_versions_create",
    {
      flowId: FLOW,
      input: { expectedLatestVersion: 1, definition: DEFINITION },
      idempotencyKey: KEY,
    },
    async () => result(true),
  );
  const data = replayed.data as Record<string, unknown>;
  assert.equal(data.outcome, "replayed");
  assert.equal(data.replayed, true);
  assert.equal(calls.length, 1);
});

test("an unknown outcome is structured guidance, not an error or a retry", async () => {
  const { result: unknown, calls } = await dispatch(
    "daykeeper_flow_versions_publish",
    {
      flowId: FLOW,
      version: 2,
      input: { expectedResourceVersion: 3 },
      idempotencyKey: KEY,
    },
    async () => {
      throw Object.assign(new Error("connection lost after dispatch"), {
        code: "NETWORK_ERROR",
        outcomeUnknown: true,
      });
    },
  );
  assert.equal(unknown.ok, true);
  const data = unknown.data as Record<string, unknown>;
  assert.equal(data.outcome, "unknown");
  assert.equal(data.idempotencyKey, KEY);
  assert.equal(data.inspectWith, "daykeeper_flows_get");
  assert.match(String(data.guidance), /never with a new key/);
  assert.deepEqual(data.nextActions, [
    "inspect_resource_before_retry",
    "reuse_original_idempotency_key",
  ]);
  assert.equal(calls.length, 1, "An unknown outcome must never be retried");
});

test("a reused key is a structured error asking for inspection first", async () => {
  const { result: reused, calls } = await dispatch(
    "daykeeper_flows_create",
    { tenantId: TENANT, input: CREATE_INPUT, idempotencyKey: KEY },
    async () => {
      throw Object.assign(new Error("private-api-detail"), {
        code: "IDEMPOTENCY_KEY_REUSED",
        status: 409,
        outcomeUnknown: false,
      });
    },
  );
  assert.equal(reused.ok, false);
  assert.equal(reused.error?.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(reused.error?.retryable, false);
  assert.match(String(reused.error?.message), /inspect/i);
  assert.deepEqual(reused.error?.nextActions, [
    "inspect_resource_before_retry",
    "use_a_fresh_key_only_for_a_different_request",
  ]);
  assert(!JSON.stringify(reused).includes("private-api-detail"));
  assert.equal(calls.length, 1);
});

test("a malformed flow write never reaches the SDK", async () => {
  for (const invalid of [
    { tenantId: TENANT, input: CREATE_INPUT },
    { tenantId: TENANT, input: CREATE_INPUT, idempotencyKey: "too-short" },
    {
      tenantId: TENANT,
      input: CREATE_INPUT,
      idempotencyKey: `${KEY} space`,
    },
    {
      tenantId: TENANT,
      input: CREATE_INPUT,
      idempotencyKey: KEY,
      scopes: ["*"],
    },
    {
      tenantId: TENANT,
      idempotencyKey: KEY,
      input: { ...CREATE_INPUT, definition: { ...DEFINITION, actions: [] } },
    },
    {
      tenantId: TENANT,
      idempotencyKey: KEY,
      input: {
        ...CREATE_INPUT,
        definition: { ...DEFINITION, schemaVersion: "1999-01-01" },
      },
    },
  ]) {
    const { result: rejected, calls } = await dispatch(
      "daykeeper_flows_create",
      invalid,
      async () => result(false),
    );
    assert.equal(rejected.ok, false);
    assert.equal(calls.length, 0);
  }
});

test(
  "candidate SDK: the three flow writes register and carry the key",
  dispatches,
  async (context) => {
    const requests: { url: string; method?: string; key: string | null }[] = [];
    const client = await harness(context, {
      ...enabled,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(url),
          method: init?.method,
          key: headers.get("idempotency-key"),
        });
        return api({
          flow: { id: FLOW, tenantId: TENANT, latestVersion: 2, secret: TOKEN },
          version: { flowId: FLOW, version: 2, contentHash: "abc" },
          replayed: false,
        });
      },
    });
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    for (const name of FLOW_WRITE_TOOLS)
      assert(tools.some((tool) => tool.name === name));
    const created = envelope(
      await client.callTool({
        name: "daykeeper_flows_create",
        arguments: {
          tenantId: TENANT,
          input: {
            name: "Refund handoff",
            slug: "refunds",
            definition: DEFINITION,
          },
          idempotencyKey: KEY,
        },
      }),
    );
    assert.equal(created.ok, true);
    // Identity only: no unknown server field is projected back to the model.
    assert.deepEqual(created.data, {
      outcome: "applied",
      replayed: false,
      idempotencyKey: KEY,
      flow: { id: FLOW, tenantId: TENANT, latestVersion: 2 },
      version: { flowId: FLOW, version: 2, contentHash: "abc" },
    });
    envelope(
      await client.callTool({
        name: "daykeeper_flow_versions_create",
        arguments: {
          flowId: FLOW,
          input: { expectedLatestVersion: 1, definition: DEFINITION },
          idempotencyKey: KEY,
        },
      }),
    );
    envelope(
      await client.callTool({
        name: "daykeeper_flow_versions_publish",
        arguments: {
          flowId: FLOW,
          version: 2,
          input: { expectedResourceVersion: 3 },
          idempotencyKey: KEY,
        },
      }),
    );
    assert.deepEqual(
      requests.map(({ url, method, key }) => [
        url.replace(BASE_URL, ""),
        method,
        key,
      ]),
      [
        [`/v1/tenants/${TENANT}/flows`, "POST", KEY],
        [`/v1/flows/${FLOW}/versions`, "POST", KEY],
        [`/v1/flows/${FLOW}/versions/2/publish`, "POST", KEY],
      ],
    );
  },
);

test(
  "candidate SDK: a replayed write is reported, never repeated",
  dispatches,
  async (context) => {
    let calls = 0;
    const client = await harness(context, {
      ...enabled,
      fetch: async () => {
        calls++;
        return api({
          flow: { id: FLOW, tenantId: TENANT },
          version: { flowId: FLOW, version: 1 },
          replayed: true,
        });
      },
    });
    const result = envelope(
      await client.callTool({
        name: "daykeeper_flows_create",
        arguments: {
          tenantId: TENANT,
          input: {
            name: "Refund handoff",
            slug: "refunds",
            definition: DEFINITION,
          },
          idempotencyKey: KEY,
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      (result.data as Record<string, unknown>).outcome,
      "replayed",
    );
    assert.equal((result.data as Record<string, unknown>).replayed, true);
    assert.equal(calls, 1);
  },
);

test(
  "candidate SDK: an unknown outcome is structured guidance, not an error",
  dispatches,
  async (context) => {
    const client = await harness(context, {
      ...enabled,
      fetch: async () => {
        throw new Error("connection lost after dispatch");
      },
    });
    const result = envelope(
      await client.callTool({
        name: "daykeeper_flow_versions_publish",
        arguments: {
          flowId: FLOW,
          version: 2,
          input: { expectedResourceVersion: 3 },
          idempotencyKey: KEY,
        },
      }),
    );
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.outcome, "unknown");
    assert.equal(data.idempotencyKey, KEY);
    assert.equal(data.inspectWith, "daykeeper_flows_get");
    assert.match(String(data.guidance), /never with a new key/);
    assert.deepEqual(data.nextActions, [
      "inspect_resource_before_retry",
      "reuse_original_idempotency_key",
    ]);
  },
);

test(
  "candidate SDK: a reused key is surfaced with inspect-first guidance",
  dispatches,
  async (context) => {
    const client = await harness(context, {
      ...enabled,
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "private-api-detail",
              retryable: false,
              nextActions: ["use_new_idempotency_key"],
            },
          },
          { status: 409 },
        ),
    });
    const result = envelope(
      await client.callTool({
        name: "daykeeper_flows_create",
        arguments: {
          tenantId: TENANT,
          input: { name: "Changed", slug: "changed", definition: DEFINITION },
          idempotencyKey: KEY,
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "IDEMPOTENCY_KEY_REUSED");
    assert.match(String(result.error?.message), /inspect/i);
    assert(
      result.error?.nextActions.includes(
        "use_a_fresh_key_only_for_a_different_request",
      ),
    );
    assert(!JSON.stringify(result).includes("private-api-detail"));
  },
);

test(
  "candidate SDK: malformed flow-write input never dispatches",
  dispatches,
  async (context) => {
    let calls = 0;
    const client = await harness(context, {
      ...enabled,
      fetch: async () => {
        calls++;
        return api({});
      },
    });
    const input = {
      name: "Refund handoff",
      slug: "refunds",
      definition: DEFINITION,
    };
    for (const invalid of [
      { tenantId: TENANT, input },
      { tenantId: TENANT, input, idempotencyKey: "too-short" },
      { tenantId: TENANT, input, idempotencyKey: `${KEY} space` },
      { tenantId: TENANT, input, idempotencyKey: KEY, scopes: ["*"] },
      {
        tenantId: TENANT,
        idempotencyKey: KEY,
        input: { ...input, definition: { ...DEFINITION, actions: [] } },
      },
      {
        tenantId: TENANT,
        idempotencyKey: KEY,
        input: {
          ...input,
          definition: { ...DEFINITION, schemaVersion: "1999-01-01" },
        },
      },
    ]) {
      const result = await client.callTool({
        name: "daykeeper_flows_create",
        arguments: invalid,
      });
      assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
  },
);
