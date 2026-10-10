import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** Bridges one Node HTTP request to the hosted dashboard's fetch handler. */
export async function forwardDashboardRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  resourceUrl: URL,
  fetchHandler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const path = incoming.url ?? "/";
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value))
        for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const method = incoming.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(new URL(path, resourceUrl.origin), {
      method,
      headers,
      ...(hasBody
        ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array> }
        : {}),
      ...(hasBody ? { duplex: "half" as const } : {}),
    });
    const response = await fetchHandler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      outgoing.end();
      return;
    }
    // pipeline, not pipe: a bounded response that errors mid-stream (size or
    // time limit) or a client that disconnects must end this response, not
    // raise an unhandled stream error that stops the process.
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      outgoing,
    ).catch(() => {
      outgoing.destroy();
    });
  } catch {
    if (!outgoing.headersSent)
      outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("MCP request could not be completed.");
  }
}
