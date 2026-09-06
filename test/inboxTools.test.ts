import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { assertInboxSdk, sdkSupportsInboxTools } from "../src/sdkInbox.ts";
import { readEnvironment, validateOptions } from "../src/config.ts";
import { createDaykeeperMcpServer } from "../src/index.ts";
import { toolCatalog, toolDefinitions } from "../src/tools.ts";
import { defaults } from "./helpers.ts";
import {
  envelope,
  harness,
  TENANT,
  api,
  BASE_URL,
  TOKEN,
  deferred,
  bounded,
} from "./helpers.ts";

const websiteSpec = {
  name: "Example company",
  slug: "example-company",
  locale: "en",
  administrator: { name: "Support operator", email: "support@example.test" },
  website: {
    websiteUrl: "https://widget.example.test",
    allowedOrigins: ["https://widget.example.test", "https://app.example.test"],
  },
};

test("inbox tools are SDK-gated and planning remains independently gated", () => {
  const names = [
    "daykeeper_website_channels_get",
    "daykeeper_inboxes_get",
    "daykeeper_tenant_provisioning_get",
    "daykeeper_website_inboxes_plan",
  ];
  for (const [enableInboxTools, enablePlanning, count] of [
    [false, false, 0],
    [false, true, 0],
    [true, false, 3],
    [true, true, 4],
  ] as const) {
    const catalog = toolCatalog(
      validateOptions({ ...defaults, enableInboxTools, enablePlanning }),
    );
    assert.equal(
      catalog.filter((tool) => names.includes(tool.name) && tool.enabled)
        .length,
      count,
    );
  }
  assert.equal(validateOptions(defaults).enableInboxTools, false);
  assert.equal(
    readEnvironment({
      DAYKEEPER_API_URL: BASE_URL,
      DAYKEEPER_API_KEY: TOKEN,
      DAYKEEPER_MCP_ENABLE_INBOX_TOOLS: "true",
    }).enableInboxTools,
    true,
  );
  assert.throws(
    () =>
      readEnvironment({
        DAYKEEPER_API_URL: BASE_URL,
        DAYKEEPER_API_KEY: TOKEN,
        DAYKEEPER_MCP_ENABLE_INBOX_TOOLS: "1",
      }),
    { code: "INVALID_CONFIGURATION" },
  );
  if (sdkSupportsInboxTools()) {
    assert.doesNotThrow(() => assertInboxSdk());
  } else {
    assert.throws(
      () => assertInboxSdk(),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "SDK_TOO_OLD" &&
        !(error as Error).cause,
    );
  }
});

for (const candidate of [
  {
    name: "website channels get",
    tool: "daykeeper_website_channels_get",
    input: { tenantId: TENANT },
    path: `/v1/tenants/${TENANT}/website-channel`,
    data: { id: "website-channel-1", tenantId: TENANT },
    method: "GET",
    options: {},
  },
  {
    name: "generic inbox get",
    tool: "daykeeper_inboxes_get",
    input: { tenantId: TENANT },
    path: `/v1/tenants/${TENANT}/inbox`,
    data: { id: "inbox-1", tenantId: TENANT, spec: { type: "api" } },
    method: "GET",
    options: {},
  },
  {
    name: "tenant provisioning get",
    tool: "daykeeper_tenant_provisioning_get",
    input: { tenantId: TENANT },
    path: `/v1/tenants/${TENANT}/provisioning-operation`,
    data: { id: "operation-1", tenantId: TENANT },
    method: "GET",
    options: {},
  },
  {
    name: "website inbox plan",
    tool: "daykeeper_website_inboxes_plan",
    input: { spec: websiteSpec },
    path: "/v1/tenant-plans",
    data: { id: "plan-1", version: 1 },
    method: "POST",
    body: websiteSpec,
    options: { enablePlanning: true },
  },
  {
    name: "API-only tenant plan",
    tool: "daykeeper_tenants_plan",
    input: {
      spec: {
        name: "API workspace",
        slug: "api-workspace",
        locale: "en",
        inbox: { type: "api" },
      },
    },
    path: "/v1/tenant-plans",
    data: { id: "plan-api-1", version: 1 },
    method: "POST",
    body: {
      name: "API workspace",
      slug: "api-workspace",
      locale: "en",
      inbox: { type: "api" },
    },
    options: { enablePlanning: true },
  },
] as const) {
  test(`candidate SDK: inbox ${candidate.name}`, async (context) => {
    if (!sdkSupportsInboxTools()) {
      context.skip("installed published SDK does not expose inbox tools");
      return;
    }
    let calls = 0;
    const client = await harness(context, {
      ...candidate.options,
      enableInboxTools: true,
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), BASE_URL + candidate.path);
        assert.equal(init?.method, candidate.method);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        assert.equal(
          init?.body,
          "body" in candidate ? JSON.stringify(candidate.body) : undefined,
        );
        assert(init?.signal instanceof AbortSignal);
        return api(candidate.data);
      },
    });
    const listing = await client.listTools();
    const listed = listing.tools.find((tool) => tool.name === candidate.tool);
    assert(listed);
    assert.equal(
      listed.annotations?.readOnlyHint,
      !candidate.name.endsWith("plan"),
    );
    assert.equal(listed.annotations?.destructiveHint, false);
    const result = envelope(
      await client.callTool({
        name: candidate.tool,
        arguments: candidate.input,
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, candidate.data);
    assert.equal(calls, 1);
    if (candidate.name === "generic inbox get") {
      let refusedCalls = 0;
      const refused = await harness(context, {
        enableInboxTools: true,
        fetch: async () => {
          refusedCalls++;
          return new Response(null, { status: 403 });
        },
      });
      const denied = envelope(
        await refused.callTool({
          name: candidate.tool,
          arguments: candidate.input,
        }),
      );
      assert.equal(denied.ok, false);
      assert.equal(denied.error?.status, 403);
      assert.equal(refusedCalls, 1, "A forbidden inbox read must not retry");

      const dispatched = deferred<void>();
      let pendingCalls = 0;
      let pendingSignal: AbortSignal | null | undefined;
      const pending = await harness(context, {
        enableInboxTools: true,
        fetch: (_url, init) => {
          pendingCalls++;
          pendingSignal = init?.signal;
          dispatched.resolve();
          return new Promise<Response>(() => undefined);
        },
      });
      const controller = new AbortController();
      const rejected = assert.rejects(
        pending.callTool(
          { name: candidate.tool, arguments: candidate.input },
          { signal: controller.signal },
        ),
      );
      await bounded(dispatched.promise);
      controller.abort();
      await bounded(rejected);
      await nextTurn();
      assert.equal(pendingSignal?.aborted, true);
      assert.equal(
        pendingCalls,
        1,
        "Cancellation must not replay an inbox read",
      );
    }
  });
}

test("inbox tool gate rejects enabled planning on an old SDK before network I/O", () => {
  if (sdkSupportsInboxTools()) {
    assert.doesNotThrow(() => assertInboxSdk());
    return;
  }
  let calls = 0;
  assert.throws(
    () =>
      createDaykeeperMcpServer({
        ...defaults,
        enableInboxTools: true,
        enablePlanning: true,
        fetch: async () => {
          calls++;
          return api({});
        },
      }),
    { code: "SDK_TOO_OLD" },
  );
  assert.equal(calls, 0);
});

test("inbox tools reject unknown fields and malformed identifiers before SDK dispatch", async () => {
  let calls = 0;
  const dispatch = async () => {
    calls++;
    return {};
  };
  const client = {
    inboxes: { get: dispatch },
    websiteChannels: { get: dispatch },
    tenants: { plan: dispatch, getProvisioningOperation: dispatch },
  } as never;
  for (const name of [
    "daykeeper_website_channels_get",
    "daykeeper_inboxes_get",
    "daykeeper_tenant_provisioning_get",
  ]) {
    const tool = toolDefinitions.find((tool) => tool.metadata.name === name)!;
    for (const input of [
      { tenantId: "../foreign" },
      { tenantId: TENANT, apiKey: TOKEN },
    ])
      assert.throws(() => tool.dispatch(client, input));
  }
  const plan = toolDefinitions.find(
    (tool) => tool.metadata.name === "daykeeper_website_inboxes_plan",
  )!;
  assert.throws(() =>
    plan.dispatch(client, {
      spec: {
        ...websiteSpec,
        website: { ...websiteSpec.website, verified: true },
      },
    }),
  );
  assert.throws(() =>
    plan.dispatch(client, { spec: { ...websiteSpec, website: undefined } }),
  );
  assert.throws(
    () =>
      plan.dispatch(client, {
        spec: { ...websiteSpec, inbox: { type: "api" } },
      }),
    { name: "ZodError" },
  );
  const tenantPlan = toolDefinitions.find(
    (tool) => tool.metadata.name === "daykeeper_tenants_plan",
  )!;
  for (const spec of [
    {
      name: "API workspace",
      slug: "api-workspace",
      locale: "en",
      inbox: { type: "api", hostedUrl: "https://attacker.example.test" },
    },
    {
      ...websiteSpec,
      website: {
        ...websiteSpec.website,
        hostedUrl: "https://attacker.example.test",
      },
    },
  ]) {
    assert.throws(() => tenantPlan.dispatch(client, { spec }));
  }
  assert.equal(
    calls,
    0,
    "Invalid plans and selectors must fail schema validation before SDK dispatch",
  );
});
