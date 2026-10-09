import type { McpServer } from "@modelcontextprotocol/server";
import type { DaykeeperMcpOptions } from "./config.ts";
import {
  createDaykeeperMcpServerForRuntime,
  LOCAL_STDIO_RUNTIME,
} from "./server.ts";
export {
  createDaykeeperMcpHttpHandler,
  DaykeeperMcpVerifierUnavailableError,
  MAX_HTTP_AUTHENTICATION_MS,
  MAX_HTTP_CONCURRENT_AUTHENTICATIONS,
  MAX_HTTP_CONCURRENT_REQUESTS,
  MAX_HTTP_CONCURRENT_REQUESTS_PER_PRINCIPAL,
  MAX_HTTP_REQUEST_BYTES,
  MAX_HTTP_REQUEST_READ_MS,
  MAX_HTTP_RESPONSE_READ_MS,
  MAX_HTTP_RESPONSE_BYTES,
} from "./http.ts";
export type {
  DaykeeperMcpHttpExchangeOptions,
  DaykeeperMcpHttpHandler,
  DaykeeperMcpHttpOptions,
  DaykeeperMcpHttpPassthroughOptions,
  DaykeeperMcpHttpPrincipal,
  DaykeeperMcpPrincipalContext,
  DaykeeperMcpRequestContext,
  DaykeeperMcpTokenVerifier,
  DaykeeperMcpVerifiedAuthInfo,
  DaykeeperMcpVerifierContext,
} from "./http.ts";

export {
  createDaykeeperIntrospectionVerifier,
  DEFAULT_INTROSPECTION_NEGATIVE_CACHE_SECONDS,
  DEFAULT_INTROSPECTION_TIMEOUT_MS,
  MAX_INTROSPECTION_CACHE_SECONDS,
  MAX_INTROSPECTION_RESPONSE_BYTES,
} from "./introspection.ts";
export type { DaykeeperIntrospectionVerifierOptions } from "./introspection.ts";
export {
  DAYKEEPER_DASHBOARD_SCOPES,
  DEFAULT_MCP_ALLOWED_ORIGINS,
  DEFAULT_MCP_HTTP_PORT,
  DEFAULT_MCP_INTERNAL_HOSTNAMES,
  PRE_AUTH_RATE_LIMIT,
  readHostedEnvironment,
  startDaykeeperMcpHttpServer,
} from "./hosted.ts";
export type {
  DaykeeperMcpHostedConfig,
  DaykeeperMcpHttpServerHandle,
} from "./hosted.ts";
export {
  DEFAULT_MCP_TRUSTED_PROXIES,
  parseTrustedProxies,
} from "./clientAddress.ts";
export {
  DASHBOARD_WIDGET_MIME_TYPE,
  DASHBOARD_WIDGET_URI,
} from "./dashboardWidget.ts";
export { DASHBOARD_TOOL_NAMES } from "./dashboard.ts";

export {
  readEnvironment,
  MCP_VERSION,
  SDK_VERSION,
  ENVELOPE_VERSION,
} from "./config.ts";
export type { DaykeeperMcpOptions, DaykeeperMcpToolProfile } from "./config.ts";

/** One local stdio instance per configured credential. This is not an HTTP authentication gateway. */
export function createDaykeeperMcpServer(
  options: DaykeeperMcpOptions,
): McpServer {
  return createDaykeeperMcpServerForRuntime(options, LOCAL_STDIO_RUNTIME);
}
