#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createDashboardHostedHandler } from "./dashboardHosted.ts";
import { DashboardMetrics } from "./dashboardMetrics.ts";

async function main(): Promise<void> {
  if (process.env.DAYKEEPER_DASHBOARD_MCP_ENABLED !== "true") {
    process.stderr.write(
      "Hosted Daykeeper Dashboard MCP is disabled; set DAYKEEPER_DASHBOARD_MCP_ENABLED=true to enable it.\n",
    );
    return;
  }
  const apiUrl = requiredUrl("DAYKEEPER_API_URL");
  const mcpResourceUrl = requiredUrl("DAYKEEPER_DASHBOARD_MCP_RESOURCE_URL");
  const issuer = requiredUrl("DAYKEEPER_OAUTH_ISSUER");
  const allowedHostnames = requiredCsv("DAYKEEPER_DASHBOARD_MCP_ALLOWED_HOSTS");
  const allowedOrigins = csv(
    process.env.DAYKEEPER_DASHBOARD_MCP_ALLOWED_ORIGINS,
  );
  const metrics = new DashboardMetrics();
  const uiPath = resolve(
    process.env.DAYKEEPER_DASHBOARD_UI_PATH ??
      "plugins/daykeeper-dashboard/ui/resource.html",
  );
  const dashboardHtml = await readFile(uiPath, "utf8");
  if (
    !/<\s*!doctype\s+html/i.test(dashboardHtml) ||
    !/<\s*html(?:\s|>)/i.test(dashboardHtml) ||
    !dashboardHtml.includes("@modelcontextprotocol/ext-apps")
  )
    throw new Error("Dashboard UI resource is not ready.");

  const handler = createDashboardHostedHandler({
    apiUrl,
    mcpResourceUrl,
    issuer,
    allowedHostnames,
    allowedOrigins,
    dashboardHtml,
    onOAuthMetric: (metric) => metrics.recordOAuth(metric),
    onToolMetric: (metric) => metrics.recordTool(metric),
  });
  const host = process.env.DAYKEEPER_DASHBOARD_MCP_BIND ?? "0.0.0.0";
  const port = parsePort(process.env.DAYKEEPER_DASHBOARD_MCP_PORT);
  const listener = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing, mcpResourceUrl, handler.fetch);
  });
  let activeHttpConnections = 0;
  listener.on("connection", (socket) => {
    activeHttpConnections++;
    metrics.setActiveHttpConnections(activeHttpConnections);
    socket.once("close", () => {
      activeHttpConnections = Math.max(0, activeHttpConnections - 1);
      metrics.setActiveHttpConnections(activeHttpConnections);
    });
  });
  const metricsTimer = setInterval(() => metrics.flush(), 60_000);
  metricsTimer.unref();
  listener.listen(port, host, () => {
    process.stdout.write(
      `Daykeeper Dashboard MCP listening on ${host}:${port}.\n`,
    );
  });
  const close = async () => {
    clearInterval(metricsTimer);
    metrics.flush();
    listener.close();
    await handler.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: import("node:http").ServerResponse,
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
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>).pipe(
      outgoing,
    );
  } catch {
    if (!outgoing.headersSent)
      outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("MCP request could not be completed.");
  }
}

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error("Hosted MCP configuration is incomplete.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Hosted MCP configuration is invalid.");
  return url;
}
function requiredCsv(name: string): string[] {
  const values = csv(process.env[name]);
  if (!values.length)
    throw new Error("Hosted MCP configuration is incomplete.");
  return values;
}
function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
function parsePort(value: string | undefined): number {
  const port = Number(value ?? 7000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("Hosted MCP port is invalid.");
  return port;
}

void main().catch(() => {
  process.stderr.write(
    "Hosted Daykeeper Dashboard MCP could not start. Check configuration; values are not logged.\n",
  );
  process.exitCode = 1;
});
