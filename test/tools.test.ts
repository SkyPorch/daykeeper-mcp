import assert from "node:assert/strict";
import test from "node:test";
import { DaykeeperApiError, type DaykeeperClient } from "@skyporch/daykeeper";
import {
  daykeeperToolDefinitions,
  executeDaykeeperTool,
} from "../src/index.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";

test("defaults to narrow read and plan tools", () => {
  const tools = daykeeperToolDefinitions(fakeClient());
  const names = tools.map((entry) => entry.name);

  assert(names.includes("daykeeper_get_capabilities"));
  assert(names.includes("daykeeper_plan_tenant"));
  assert(names.includes("daykeeper_list_flows"));
  assert(!names.includes("daykeeper_apply_tenant_plan"));
  assert(!names.includes("daykeeper_create_flow"));
  assert.equal(
    tools.find((entry) => entry.name === "daykeeper_get_tenant")?.annotations
      .readOnlyHint,
    true,
  );
});

test("registers only idempotent provisioning applies with the mutation gate", async () => {
  let applied: unknown;
  const client = fakeClient({
    tenants: {
      ...fakeClient().tenants,
      apply: async (input, options) => {
        applied = { input, options };
        return { tenant: {}, operation: {}, replayed: false } as never;
      },
    },
  });
  const tools = daykeeperToolDefinitions(client, { allowMutations: true });
  const apply = tools.find(
    (entry) => entry.name === "daykeeper_apply_tenant_plan",
  );

  assert(apply);
  assert.equal(apply.annotations.idempotentHint, true);
  assert(!tools.some((entry) => entry.name === "daykeeper_create_flow"));
  const result = await executeDaykeeperTool(apply, {
    planId,
    planVersion: 1,
    idempotencyKey: "agent-run-123456",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(applied, {
    input: { planId, planVersion: 1 },
    options: { idempotencyKey: "agent-run-123456" },
  });
});

test("keeps non-idempotent flow writes behind a separate unsafe gate", () => {
  const tools = daykeeperToolDefinitions(fakeClient(), {
    allowUnsafeFlowMutations: true,
  });
  const create = tools.find((entry) => entry.name === "daykeeper_create_flow");

  assert(create);
  assert.equal(create.annotations.readOnlyHint, false);
  assert.equal(create.annotations.idempotentHint, false);
  assert.equal(create.annotations.openWorldHint, true);
});

test("returns structured API failures without credential or stack leakage", async () => {
  const definition = {
    name: "failure",
    title: "Failure",
    description: "Failure",
    inputSchema: {},
    annotations: {},
    execute: async () => {
      throw new DaykeeperApiError({
        status: 409,
        code: "RESOURCE_VERSION_CONFLICT",
        message: "The resource changed",
        retryable: false,
        nextActions: ["read_latest_version"],
        correlationId: "request-1",
      });
    },
  } as never;

  const result = await executeDaykeeperTool(definition, {});
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /RESOURCE_VERSION_CONFLICT/,
  );
  assert(!JSON.stringify(result).includes("stack"));
});

function fakeClient(overrides: Partial<DaykeeperClient> = {}): DaykeeperClient {
  const client = {
    capabilities: async () => ({}),
    tenants: {
      list: async () => [],
      get: async () => ({ id: tenantId }),
      plan: async () => ({ id: planId }),
      apply: async () => ({ tenant: {}, operation: {}, replayed: false }),
    },
    emailChannels: {
      get: async () => ({}),
      plan: async () => ({}),
      apply: async () => ({ channel: {}, operation: {}, replayed: false }),
    },
    operations: {
      get: async () => ({}),
      retry: async () => ({}),
    },
    flows: {
      list: async () => [],
      get: async () => ({}),
      getVersion: async () => ({}),
      create: async () => ({}),
      createVersion: async () => ({}),
      publishVersion: async () => ({}),
    },
    ...overrides,
  };
  return client as unknown as DaykeeperClient;
}
