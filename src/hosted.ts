import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
  createDaykeeperMcpHttpHandler,
  type DaykeeperMcpHttpHandler,
} from "./http.ts";
import { createDaykeeperIntrospectionVerifier } from "./introspection.ts";

/** The five scopes Daykeeper's OAuth server grants to ChatGPT connections. */
export const DAYKEEPER_DASHBOARD_SCOPES = Object.freeze([
  "daykeeper.accounts:read",
  "daykeeper.accounts:write",
  "daykeeper.billing:read",
  "daykeeper.conversations:read",
  "daykeeper.conversations:write",
]);
export const DEFAULT_MCP_HTTP_PORT = 4108;
/** ChatGPT's web origin. MCP traffic itself is server-to-server. */
export const DEFAULT_MCP_ALLOWED_ORIGINS = Object.freeze([
  "https://chatgpt.com",
]);
/** The compose service name of the Daykeeper API on the private network. */
export const DEFAULT_MCP_INTERNAL_HOSTNAMES = Object.freeze(["daykeeper-api"]);
const SHUTDOWN_GRACE_MS = 10_000;

export interface DaykeeperMcpHostedConfig {
  readonly port: number;
  readonly host: string;
  readonly resourceUrl: URL;
  readonly allowedHostnames: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly internalApiUrl: URL;
  readonly internalHostnames: readonly string[];
  readonly introspectionSecret: string;
  readonly issuer: string;
  /** `_meta.ui.domain`: required by OpenAI to submit a plugin with UI. */
  readonly widgetDomain: string;
}

export interface DaykeeperMcpHttpServerHandle {
  readonly server: Server;
  /** The bound `http://host:port` address, for health checks and tests. */
  readonly address: string;
  readonly handler: DaykeeperMcpHttpHandler;
  readonly close: () => Promise<void>;
}

/**
 * Read the hosted configuration. Every value is explicit; nothing is guessed
 * and no value is ever echoed in an error.
 */
export function readHostedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): DaykeeperMcpHostedConfig {
  const fail = (name: string): never => {
    throw new TypeError(`Invalid or missing ${name}. Values are not logged.`);
  };
  const list = (name: string, fallback: readonly string[]) => {
    const value = environment[name];
    if (value === undefined) return [...fallback];
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (items.length === 0) fail(name);
    return items;
  };
  const required = (name: string) => {
    const value = environment[name];
    if (value === undefined || value === "" || value !== value.trim())
      return fail(name);
    return value;
  };
  const url = (name: string) => {
    try {
      return new URL(required(name));
    } catch {
      return fail(name);
    }
  };
  const portText = environment.DAYKEEPER_MCP_HTTP_PORT;
  const port =
    portText === undefined ? DEFAULT_MCP_HTTP_PORT : Number(portText);
  if (
    (portText !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(portText)) ||
    port > 65_535
  )
    fail("DAYKEEPER_MCP_HTTP_PORT");
  const resourceUrl = url("DAYKEEPER_MCP_RESOURCE_URL");
  const issuer = required("DAYKEEPER_OAUTH_ISSUER");
  if (!/^https:\/\/[^/?#\s]+$/.test(issuer)) fail("DAYKEEPER_OAUTH_ISSUER");
  // OpenAI requires a dedicated, per-plugin widget origin to submit a plugin
  // with UI, so the hosted entrypoint refuses to start without one.
  const widgetDomain = required("DAYKEEPER_MCP_WIDGET_DOMAIN");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(widgetDomain))
    fail("DAYKEEPER_MCP_WIDGET_DOMAIN");
  return Object.freeze({
    port,
    host: environment.DAYKEEPER_MCP_HTTP_HOST ?? "0.0.0.0",
    resourceUrl,
    allowedHostnames: list("DAYKEEPER_MCP_ALLOWED_HOSTNAMES", [
      resourceUrl.hostname,
    ]),
    allowedOrigins: list(
      "DAYKEEPER_MCP_ALLOWED_ORIGINS",
      DEFAULT_MCP_ALLOWED_ORIGINS,
    ),
    internalApiUrl: url("DAYKEEPER_INTERNAL_API_URL"),
    internalHostnames: list(
      "DAYKEEPER_MCP_INTERNAL_HOSTNAMES",
      DEFAULT_MCP_INTERNAL_HOSTNAMES,
    ),
    introspectionSecret: required("DAYKEEPER_OAUTH_INTROSPECTION_SECRET"),
    issuer,
    widgetDomain,
  });
}

/**
 * Start the hosted Daykeeper Dashboard MCP server: a node:http listener in
 * front of `createDaykeeperMcpHttpHandler`, verifying bearers by
 * introspection and passing them through to the internal API. Serves
 * `/healthz`, the RFC 9728 metadata for the resource and the MCP endpoint;
 * the authorization server metadata belongs to the API app on this origin.
 */
export async function startDaykeeperMcpHttpServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: {
    /** Test seam: transport for introspection and API calls. */
    readonly fetch?: typeof globalThis.fetch;
    readonly onerror?: (message: string) => void;
  } = {},
): Promise<DaykeeperMcpHttpServerHandle> {
  const config = readHostedEnvironment(environment);
  const introspectionUrl = new URL(
    `${config.internalApiUrl.href.replace(/\/$/, "")}/oauth/introspect`,
  );
  const verifier = createDaykeeperIntrospectionVerifier({
    introspectionUrl,
    clientSecret: config.introspectionSecret,
    internalHttpHostnames: config.internalHostnames,
    issuer: config.issuer,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const handler = createDaykeeperMcpHttpHandler({
    resourceServerUrl: config.resourceUrl,
    daykeeperApiUrl: config.internalApiUrl,
    authorizationServerIssuer: config.issuer,
    serveAuthorizationServerMetadata: false,
    downstreamCredential: "passthrough",
    passthrough: {
      toolProfile: "dashboard",
      internalHttpHostnames: config.internalHostnames,
      widgetDomain: config.widgetDomain,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
    verifier,
    allowedHostnames: config.allowedHostnames,
    allowedOrigins: config.allowedOrigins,
    scopesSupported: [...DAYKEEPER_DASHBOARD_SCOPES],
    serviceDocumentationUrl: new URL("https://www.mydaykeeper.com/docs"),
    onerror: options.onerror,
  });

  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    void serve(handler, config.resourceUrl, request, response).catch(() => {
      options.onerror?.("Daykeeper MCP HTTP request failed.");
      if (!response.headersSent) {
        response.writeHead(500, { "cache-control": "no-store" });
      }
      response.end();
    });
  });
  server.requestTimeout = 75_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  const host = bound.family === "IPv6" ? `[${bound.address}]` : bound.address;

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeIdleConnections();
      await handler.close();
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, SHUTDOWN_GRACE_MS);
      timer.unref();
      await stopped;
      clearTimeout(timer);
    })());

  return Object.freeze({
    server,
    address: `http://${host}:${bound.port}`,
    handler,
    close,
  });
}

async function serve(
  handler: DaykeeperMcpHttpHandler,
  resourceUrl: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = request.url ?? "/";
  if (
    path === "/healthz" &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(request.method === "HEAD" ? undefined : "ok\n");
    return;
  }
  // Origin-form only: an absolute-form target could name another origin.
  if (!path.startsWith("/") || path.startsWith("//")) {
    response.writeHead(400, { "cache-control": "no-store" });
    response.end();
    return;
  }
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const fetchRequest = new Request(new URL(path, resourceUrl.origin), {
    method,
    headers,
    body: hasBody
      ? (Readable.toWeb(request) as ReadableStream<Uint8Array>)
      : null,
    signal: controller.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
  const answer = await handler.fetch(fetchRequest);
  const outgoing: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    outgoing[name] = value;
  });
  response.writeHead(answer.status, outgoing);
  if (!answer.body || method === "HEAD") {
    void answer.body?.cancel().catch(() => undefined);
    response.end();
    return;
  }
  const reader = answer.body.getReader();
  controller.signal.addEventListener(
    "abort",
    () => void reader.cancel().catch(() => undefined),
    { once: true },
  );
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!response.write(next.value))
        await new Promise<void>((resolve) => {
          const done = () => {
            response.off("drain", done);
            response.off("close", done);
            resolve();
          };
          response.once("drain", done);
          response.once("close", done);
        });
      if (controller.signal.aborted) break;
    }
  } catch {
    // A cancelled or failed stream ends the response below.
  } finally {
    response.end();
  }
}
