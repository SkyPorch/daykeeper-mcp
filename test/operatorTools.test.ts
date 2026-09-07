import assert from "node:assert/strict";
import test from "node:test";
import { validateOptions } from "../src/config.ts";
import { toolCatalog, toolDefinitions } from "../src/tools.ts";
import {
  defaults,
  TENANT,
  BASE_URL,
  TOKEN,
  api,
  envelope,
  harness,
} from "./helpers.ts";
import { sdkSupportsOperatorConversations } from "../src/sdkOperator.ts";

test("operator tools require separate read and write opt-ins", () => {
  const names = [
    "daykeeper_operator_conversations_list",
    "daykeeper_operator_conversation_messages",
    "daykeeper_operator_conversation_reply",
  ];
  const disabled = toolCatalog(validateOptions(defaults));
  assert.deepEqual(
    disabled.filter((tool) => names.includes(tool.name) && tool.enabled),
    [],
  );
  const reads = toolCatalog(
    validateOptions({ ...defaults, enableOperatorTools: true }),
  );
  assert.equal(reads.find((tool) => tool.name === names[0])?.enabled, true);
  assert.equal(reads.find((tool) => tool.name === names[2])?.enabled, false);
  const writes = toolCatalog(
    validateOptions({
      ...defaults,
      enableMutations: true,
      enableOperatorTools: true,
      enableOperatorWrites: true,
    }),
  );
  assert.equal(writes.find((tool) => tool.name === names[2])?.enabled, true);
});

test("operator tool inputs are tenant-qualified and reply content is bounded", async () => {
  const list = toolDefinitions.find(
    (definition) =>
      definition.metadata.name === "daykeeper_operator_conversations_list",
  )!;
  const reply = toolDefinitions.find(
    (definition) =>
      definition.metadata.name === "daykeeper_operator_conversation_reply",
  )!;
  const calls: unknown[] = [];
  const client = {
    operatorConversations: {
      list: async (tenantId: string) => {
        calls.push(["list", tenantId]);
        return {};
      },
      messages: async () => ({}),
      reply: async (...args: unknown[]) => {
        calls.push(["reply", ...args]);
        return {};
      },
    },
  } as never;
  await list.dispatch(client, {
    tenantId: TENANT,
  });
  assert.throws(() => list.dispatch(client, { tenantId: "not-a-tenant" }));
  await reply.dispatch(client, {
    tenantId: TENANT,
    conversationId: 12,
    content: "  hello  ",
  });
  assert.throws(() =>
    reply.dispatch(client, {
      tenantId: TENANT,
      conversationId: 12,
      content: " ".repeat(4_000),
    }),
  );
  assert.deepEqual(calls, [
    ["list", TENANT],
    ["reply", TENANT, 12, "  hello  ", { signal: undefined }],
  ]);
});

for (const candidate of [
  [
    "daykeeper_operator_conversations_list",
    { tenantId: TENANT },
    `/v1/tenants/${TENANT}/conversations`,
    "GET",
  ],
  [
    "daykeeper_operator_conversation_messages",
    { tenantId: TENANT, conversationId: 42 },
    `/v1/tenants/${TENANT}/conversations/42/messages`,
    "GET",
  ],
  [
    "daykeeper_operator_conversation_reply",
    { tenantId: TENANT, conversationId: 42, content: "Reply" },
    `/v1/tenants/${TENANT}/conversations/42/messages`,
    "POST",
  ],
] as const) {
  test(`candidate SDK: ${candidate[0]}`, async (context) => {
    if (!sdkSupportsOperatorConversations()) {
      context.skip("installed SDK does not expose operator conversations");
      return;
    }
    let calls = 0;
    const client = await harness(context, {
      enableOperatorTools: true,
      enableOperatorWrites: candidate[3] === "POST",
      enableMutations: candidate[3] === "POST",
      scopes: [
        candidate[3] === "POST"
          ? "daykeeper.conversations:write"
          : "daykeeper.conversations:read",
      ],
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), BASE_URL + candidate[2]);
        assert.equal(init?.method, candidate[3]);
        return api({
          tenantId: TENANT,
          ...(candidate[3] === "POST"
            ? {
                conversationId: 42,
                message: {
                  id: 9,
                  conversationId: 42,
                  senderType: "User",
                  messageType: 1,
                  content: "Reply",
                  createdAt: "now",
                },
              }
            : candidate[0].endsWith("messages")
              ? { conversationId: 42, messages: [] }
              : { conversations: [] }),
        });
      },
    });
    const result = envelope(
      await client.callTool({ name: candidate[0], arguments: candidate[1] }),
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
  });
}

for (const failure of [401, 429, 500] as const) {
  test(`candidate SDK: operator reply does not retry HTTP ${failure}`, async (context) => {
    if (!sdkSupportsOperatorConversations()) {
      context.skip("installed SDK does not expose operator conversations");
      return;
    }
    let calls = 0;
    const client = await harness(context, {
      enableMutations: true,
      enableOperatorTools: true,
      enableOperatorWrites: true,
      scopes: ["daykeeper.conversations:write"],
      fetch: async () => {
        calls++;
        return api({ error: "rejected" }, failure);
      },
    });
    const result = envelope(
      await client.callTool({
        name: "daykeeper_operator_conversation_reply",
        arguments: { tenantId: TENANT, conversationId: 42, content: "Reply" },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  });
}

test("candidate SDK: operator reply network loss is single-dispatch and unknown", async (context) => {
  if (!sdkSupportsOperatorConversations()) {
    context.skip("installed SDK does not expose operator conversations");
    return;
  }
  let calls = 0;
  const client = await harness(context, {
    enableMutations: true,
    enableOperatorTools: true,
    enableOperatorWrites: true,
    scopes: ["daykeeper.conversations:write"],
    fetch: async () => {
      calls++;
      throw new Error("connection lost");
    },
  });
  const result = envelope(
    await client.callTool({
      name: "daykeeper_operator_conversation_reply",
      arguments: { tenantId: TENANT, conversationId: 42, content: "Reply" },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.equal(calls, 1);
});
