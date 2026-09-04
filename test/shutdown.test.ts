import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDaykeeperMcpServer } from "../src/index.ts";
import { validateOptions } from "../src/config.ts";
import { createExecutor } from "../src/transport.ts";
import type { ToolMetadata } from "../src/tools.ts";
import { api, bounded, defaults, deferred, envelope } from "./helpers.ts";

for (const era of ["legacy", "modern"] as const) {
  for (const reuseId of [false, true]) {
    test(`${era}: close aborts every active request, duplicate IDs=${reuseId}`, async (context) => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const dispatched = deferred<void>();
      const pending: Array<ReturnType<typeof deferred<Response>>> = [];
      const signals: AbortSignal[] = [];
      const handle = serveStdio(
        () =>
          createDaykeeperMcpServer({
            ...defaults,
            fetch: (_input, init) => {
              assert(init?.signal);
              signals.push(init.signal);
              const response = deferred<Response>();
              pending.push(response);
              if (signals.length === 2) dispatched.resolve();
              return response.promise;
            },
          }),
        { transport: serverTransport },
      );
      const client = new Client(
        { name: "daykeeper-close-test", version: "0.0.0" },
        {
          versionNegotiation: {
            mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
          },
        },
      );
      context.after(async () => {
        await client.close();
        await handle.close();
      });
      await client.connect(clientTransport, { timeout: 2_000 });
      const meta =
        era === "legacy"
          ? {}
          : {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "daykeeper-close-test",
                  version: "0.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            };
      for (const id of [101, reuseId ? 101 : 102]) {
        await clientTransport.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "daykeeper_capabilities", arguments: {}, ...meta },
        });
      }
      await bounded(dispatched.promise);
      assert.deepEqual(
        signals.map((signal) => signal.aborted),
        [false, false],
      );
      await handle.close();
      await nextTurn();
      assert.deepEqual(
        signals.map((signal) => signal.aborted),
        [true, true],
      );
      for (const response of pending)
        response.reject(new Error("synthetic late close rejection"));
      await nextTurn();
    });
  }
}

test("disposed executor rejects future work without dispatching, including after active call cleanup", async () => {
  const lifetime = new AbortController();
  let calls = 0;
  const execute = createExecutor(
    validateOptions(defaults),
    async () => {
      calls++;
      return api({});
    },
    lifetime.signal,
  );
  const metadata: ToolMetadata = {
    name: "daykeeper_capabilities",
    effect: "read",
    scopes: ["daykeeper.accounts:read"],
    description: "Test read",
    idempotent: true,
    destructive: false,
    requiresIdempotencyKey: false,
    requiresFlowWrites: false,
  };
  assert.equal(
    envelope(
      await execute(
        metadata,
        {},
        (client) => client.capabilities(),
        new AbortController().signal,
      ),
    ).ok,
    true,
  );
  lifetime.abort(new Error("private shutdown reason"));
  const result = envelope(
    await execute(
      metadata,
      {},
      (client) => client.capabilities(),
      new AbortController().signal,
    ),
  );
  assert.equal(result.error?.code, "ADAPTER_CLOSED");
  assert(!JSON.stringify(result).includes("private shutdown reason"));
  assert.equal(calls, 1);
});
