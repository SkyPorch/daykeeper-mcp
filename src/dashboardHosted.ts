import {
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import {
  createDaykeeperMcpHttpHandler,
  type DaykeeperMcpHttpHandler,
  type DaykeeperMcpHttpPrincipal,
  type DaykeeperMcpTokenVerifier,
  type DaykeeperMcpVerifiedAuthInfo,
} from "./http.ts";
import {
  createDashboardMcpServer,
  type DashboardToolMetric,
} from "./dashboardServer.ts";

export type DashboardOAuthMetric = {
  readonly operation: "introspection" | "exchange";
  readonly outcome: "success" | "failure";
};

export const DASHBOARD_SCOPES = Object.freeze([
  "daykeeper.accounts:read",
  "daykeeper.accounts:write",
  "daykeeper.billing:read",
  "daykeeper.conversations:read",
  "daykeeper.conversations:write",
]);

export interface DashboardHostedOptions {
  readonly apiUrl: URL;
  readonly mcpResourceUrl: URL;
  readonly issuer: URL;
  readonly allowedHostnames: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly dashboardHtml: string;
  readonly fetchImpl?: typeof fetch;
  readonly onToolMetric?: (metric: DashboardToolMetric) => void;
  readonly onOAuthMetric?: (metric: DashboardOAuthMetric) => void;
}

/** OAuth resource adapter: MCP token in, separately exchanged API token out. */
export function createDashboardHostedHandler(
  options: DashboardHostedOptions,
): DaykeeperMcpHttpHandler {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const verifier: DaykeeperMcpTokenVerifier = {
    async verifyAccessToken(token, context) {
      try {
        const response = await apiCall(
          fetchImpl,
          options.apiUrl,
          "/v1/oauth/introspect",
          token,
          context.signal,
        );
        const value = objectValue(response.data);
        if (
          value.active !== true ||
          value.resource !== options.mcpResourceUrl.href ||
          typeof value.clientId !== "string" ||
          typeof value.connectionId !== "string" ||
          typeof value.userId !== "string" ||
          typeof value.organizationId !== "string" ||
          typeof value.expiresAt !== "string" ||
          !Array.isArray(value.scopes)
        )
          throw new Error("invalid_token");
        const scopes = value.scopes.filter(
          (scope): scope is string =>
            typeof scope === "string" &&
            DASHBOARD_SCOPES.includes(
              scope as (typeof DASHBOARD_SCOPES)[number],
            ),
        );
        if (scopes.length !== value.scopes.length)
          throw new Error("invalid_scopes");
        const expiresAt = Math.floor(Date.parse(value.expiresAt) / 1_000);
        const now = Math.floor(Date.now() / 1_000);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
          throw new Error("expired_token");
        const auth: DaykeeperMcpVerifiedAuthInfo = {
          token,
          clientId: value.clientId,
          scopes,
          expiresAt,
          resource: new URL(value.resource),
          extra: {
            daykeeperPrincipalId: `${value.userId}:${value.organizationId}`,
            daykeeperGrantId: value.connectionId,
          },
        };
        report(options.onOAuthMetric, {
          operation: "introspection",
          outcome: "success",
        });
        return auth;
      } catch (error) {
        report(options.onOAuthMetric, {
          operation: "introspection",
          outcome: "failure",
        });
        throw error;
      }
    },
  };

  const oauthMetadata = {
    issuer: options.issuer.origin,
    authorization_endpoint: new URL("/oauth/authorize", options.issuer).href,
    token_endpoint: new URL("/oauth/token", options.issuer).href,
    revocation_endpoint: new URL("/oauth/revoke", options.issuer).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  } as OAuthMetadata & {
    authorization_response_iss_parameter_supported: true;
    client_id_metadata_document_supported: true;
  };

  return createDaykeeperMcpHttpHandler({
    resourceServerUrl: options.mcpResourceUrl,
    daykeeperApiUrl: options.apiUrl,
    oauthMetadata,
    verifier,
    requiredScopes: ["daykeeper.accounts:read"],
    scopesSupported: DASHBOARD_SCOPES,
    allowedHostnames: options.allowedHostnames,
    allowedOrigins: options.allowedOrigins,
    resolvePrincipal: async (authInfo, { signal }) => {
      try {
        const response = await apiCall(
          fetchImpl,
          options.apiUrl,
          "/v1/oauth/exchange",
          authInfo.token,
          signal,
        );
        const value = objectValue(response.data);
        if (
          typeof value.access_token !== "string" ||
          value.token_type !== "Bearer" ||
          !Number.isSafeInteger(value.expires_in) ||
          Number(value.expires_in) < 1
        )
          throw new Error("invalid_exchange");
        const now = Math.floor(Date.now() / 1_000);
        const scopes = [...authInfo.scopes];
        const apiPrincipal: DaykeeperMcpHttpPrincipal = {
          principalId: authInfo.extra.daykeeperPrincipalId,
          grantId: authInfo.extra.daykeeperGrantId,
          downstreamExpiresAt: Math.min(
            authInfo.expiresAt,
            now + Number(value.expires_in),
          ),
          daykeeper: {
            baseUrl: options.apiUrl.href,
            accessToken: value.access_token,
            timeoutMs: 30_000,
            enablePlanning: false,
            enableMutations: true,
            enableOperatorTools: true,
            enableOperatorWrites: true,
            scopes,
          },
        };
        report(options.onOAuthMetric, {
          operation: "exchange",
          outcome: "success",
        });
        return apiPrincipal;
      } catch (error) {
        report(options.onOAuthMetric, {
          operation: "exchange",
          outcome: "failure",
        });
        throw error;
      }
    },
    createServer: (principal, runtime) =>
      createDashboardMcpServer(
        principal,
        runtime,
        options.dashboardHtml,
        getOAuthProtectedResourceMetadataUrl(options.mcpResourceUrl),
        options.onToolMetric,
      ),
  });
}

function report<Metric>(
  callback: ((metric: Metric) => void) | undefined,
  metric: Metric,
): void {
  try {
    callback?.(metric);
  } catch {
    // Metrics are best-effort and never affect authorization or API work.
  }
}

async function apiCall(
  fetchImpl: typeof fetch,
  apiUrl: URL,
  path: string,
  token: string,
  parentSignal: AbortSignal,
): Promise<{ data?: unknown }> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(new URL(path, apiUrl), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("dashboard_authentication_failed");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 32_768) {
      await response.body?.cancel();
      throw new Error("dashboard_authentication_response_too_large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("dashboard_authentication_response_invalid");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32_768) {
        await reader.cancel();
        throw new Error("dashboard_authentication_response_too_large");
      }
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks, size);
    return objectValue(JSON.parse(new TextDecoder().decode(bytes))) as {
      data?: unknown;
    };
  } finally {
    clearTimeout(timer);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
