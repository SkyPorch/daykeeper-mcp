import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { forwardDashboardRequest } from "../src/dashboardNodeBridge.ts";

const resourceUrl = new URL("https://dashboard.example.test/mcp");

async function serve(
  fetchHandler: (request: Request) => Promise<Response>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((incoming, outgoing) => {
    void forwardDashboardRequest(incoming, outgoing, resourceUrl, fetchHandler);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      let aborted = false;
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("aborted", () => (aborted = true));
      res.on("error", () => (aborted = true));
      res.on("close", () =>
        resolve({ status: res.statusCode ?? 0, body, aborted }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("the Node bridge forwards path, method, headers, and a streamed body", async (context) => {
  const seen: string[] = [];
  const server = await serve(async (request) => {
    seen.push(`${request.method} ${request.url}`);
    return new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  context.after(server.close);
  const response = await get(server.port, "/mcp?x=1");
  assert.equal(response.status, 200);
  assert.equal(response.body, "hello");
  assert.deepEqual(seen, ["GET https://dashboard.example.test/mcp?x=1"]);
});

test("a response stream that errors mid-body ends that response and keeps serving", async (context) => {
  let calls = 0;
  const server = await serve(async () => {
    calls++;
    if (calls > 1) return new Response("still serving");
    // What boundedResponse does when a response exceeds its size or time limit.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        setTimeout(
          () => controller.error(new Error("MCP response is too large.")),
          10,
        );
      },
    });
    return new Response(body, { status: 200 });
  });
  context.after(server.close);
  const failed = await get(server.port, "/mcp");
  assert.equal(failed.status, 200);
  assert.equal(failed.aborted, true);
  // An unhandled stream error would have stopped the process (and this test)
  // before the second request could be served.
  const next = await get(server.port, "/mcp");
  assert.equal(next.body, "still serving");
});

test("a handler failure before headers answers a data-free 503", async (context) => {
  const server = await serve(async () => {
    throw new Error("token=secret-value");
  });
  context.after(server.close);
  const response = await get(server.port, "/mcp");
  assert.equal(response.status, 503);
  assert.equal(response.body, "MCP request could not be completed.");
});
