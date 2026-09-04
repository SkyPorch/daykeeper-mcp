import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createDaykeeperMcpServer,
  type DaykeeperMcpOptions,
} from "../src/index.ts";
import { outputSchema } from "../src/schemas.ts";

export const TOKEN = "daykeeper_mcp_synthetic_token_123456789";
export const TENANT = "11111111-1111-4111-8111-111111111111";
export const FOREIGN = "22222222-2222-4222-8222-222222222222";
export const FLOW = "33333333-3333-4333-8333-333333333333";
export const OPERATION = "44444444-4444-4444-8444-444444444444";
export const PLAN = "55555555-5555-4555-8555-555555555555";
export const KEY = "0000000000000000";
export const BASE_URL = "https://api.example.test/proxy";
export const defaults = { baseUrl: BASE_URL, accessToken: TOKEN };

export async function harness(
  context: TestContext,
  options: Partial<DaykeeperMcpOptions> = {},
  era: "legacy" | "modern" = "legacy",
) {
  const { apiKey, accessToken, ...settings } = options;
  const credential =
    apiKey !== undefined
      ? { apiKey }
      : { accessToken: accessToken ?? defaults.accessToken };
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = serveStdio(
    () =>
      createDaykeeperMcpServer({
        baseUrl: defaults.baseUrl,
        fetch: async () => {
          throw new Error("Unexpected network dispatch");
        },
        ...settings,
        ...credential,
      } as DaykeeperMcpOptions),
    { transport: serverTransport, legacy: "serve", maxSubscriptions: 0 },
  );
  const client = new Client(
    { name: "daykeeper-test", version: "0.0.0" },
    {
      versionNegotiation: {
        mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
      },
    },
  );
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect(clientTransport, { timeout: 3_000 });
  return client;
}

export function envelope(result: CallToolResult) {
  const parsed = outputSchema.parse(result.structuredContent);
  assert.equal(result.isError, !parsed.ok);
  // Modern MCP may project text from structured output. Both must represent
  // the same envelope, without assuming a particular pretty-print style.
  for (const content of result.content) {
    if (content.type === "text")
      assert.deepEqual(JSON.parse(content.text), parsed);
  }
  assert(!JSON.stringify(result).includes(TOKEN));
  return parsed;
}

export function api(data: unknown, status = 200): Response {
  return Response.json({ data }, { status });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfilled, failed) => {
    resolve = fulfilled;
    reject = failed;
  });
  return { promise, resolve, reject };
}

export async function bounded<T>(
  promise: Promise<T>,
  milliseconds = 3_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test exceeded its local watchdog")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
