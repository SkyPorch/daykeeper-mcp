import { McpAdapterError } from "./errors.ts";

export const MCP_VERSION = "0.2.0";
export const SDK_VERSION = "0.2.0";
export const ENVELOPE_VERSION = "1.0";
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_INPUT_BYTES = 524_288;
export const MAX_CONCURRENT_REQUESTS = 4;

interface DaykeeperMcpBaseOptions {
  baseUrl: string;
  timeoutMs?: number;
  enablePlanning?: boolean;
  enableMutations?: boolean;
  /** Second, independent gate for flow create/revise/publish writes. */
  enableFlowWrites?: boolean;
  /** SDK-gated website planning and inbox/provisioning inspection. */
  enableInboxTools?: boolean;
  /** SDK-gated inbox activation inspection and mutations. */
  enableActivationTools?: boolean;
  /** Explicit opt-in for tenant conversation reads. */
  enableOperatorTools?: boolean;
  /** Separate explicit approval for outgoing operator replies. */
  enableOperatorWrites?: boolean;
  /**
   * The exact scopes the configured credential is known to hold. Omitted means
   * the operator did not declare them; flow writes then refuse rather than
   * guess. This never grants anything: the API remains the authority.
   */
  scopes?: readonly string[];
  fetch?: typeof globalThis.fetch;
}

// Matches the scope names published by the management SDK contract.
const SCOPE_PATTERN = /^daykeeper\.[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,31}$/;
const MAX_SCOPES = 32;

export type DaykeeperMcpOptions = DaykeeperMcpBaseOptions &
  (
    | {
        /** Static, scoped server-side credential for a headless workload. */
        apiKey: string;
        accessToken?: never;
      }
    | {
        /** Short-lived OAuth access token supplied by the MCP host. */
        accessToken: string;
        apiKey?: never;
      }
  );

export interface DaykeeperMcpConfig {
  readonly baseUrl: string;
  /** Normalized bearer value; credentialMode retains its input semantics. */
  readonly accessToken: string;
  readonly credentialMode: "api_key" | "access_token";
  readonly timeoutMs: number;
  readonly enablePlanning: boolean;
  readonly enableMutations: boolean;
  readonly enableFlowWrites: boolean;
  readonly enableInboxTools: boolean;
  readonly enableActivationTools: boolean;
  readonly enableOperatorTools: boolean;
  readonly enableOperatorWrites: boolean;
  /** Undefined when the operator declared no scope list. */
  readonly scopes: readonly string[] | undefined;
}

export function validateOptions(
  options: DaykeeperMcpOptions,
): DaykeeperMcpConfig {
  try {
    if (
      typeof options.baseUrl !== "string" ||
      options.baseUrl !== options.baseUrl.trim()
    )
      throw invalidConfig();
    const url = new URL(options.baseUrl);
    // These are the loopback hosts supported by the pinned management SDK.
    const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw invalidConfig();
    const hasApiKey =
      "apiKey" in options && typeof options.apiKey !== "undefined";
    const hasAccessToken =
      "accessToken" in options && typeof options.accessToken !== "undefined";
    if (hasApiKey === hasAccessToken) throw invalidConfig();
    const credential = hasApiKey ? options.apiKey : options.accessToken;
    if (
      typeof credential !== "string" ||
      credential.length < 20 ||
      credential.length > 16_384 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(credential)
    )
      throw invalidConfig();
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)
      throw invalidConfig();
    for (const flag of [
      options.enablePlanning,
      options.enableMutations,
      options.enableFlowWrites,
      options.enableInboxTools,
      options.enableActivationTools,
      options.enableOperatorTools,
      options.enableOperatorWrites,
    ]) {
      if (flag !== undefined && typeof flag !== "boolean")
        throw invalidConfig();
    }
    const scopes = normalizeScopes(options.scopes);
    return Object.freeze({
      baseUrl: url.href.replace(/\/$/, ""),
      accessToken: credential,
      credentialMode: hasApiKey ? "api_key" : "access_token",
      timeoutMs,
      enablePlanning: options.enablePlanning ?? false,
      enableMutations: options.enableMutations ?? false,
      enableFlowWrites: options.enableFlowWrites ?? false,
      enableInboxTools: options.enableInboxTools ?? false,
      enableActivationTools: options.enableActivationTools ?? false,
      enableOperatorTools: options.enableOperatorTools ?? false,
      enableOperatorWrites: options.enableOperatorWrites ?? false,
      scopes,
    });
  } catch {
    throw invalidConfig();
  }
}

export function readEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): DaykeeperMcpOptions {
  const flag = (key: string): boolean => {
    const value = environment[key];
    if (value !== undefined && value !== "true" && value !== "false")
      throw invalidConfig();
    return value === "true";
  };
  const timeout = environment.DAYKEEPER_TIMEOUT_MS;
  if (timeout !== undefined && !/^[1-9][0-9]*$/.test(timeout))
    throw invalidConfig();
  const declared = environment.DAYKEEPER_MCP_SCOPES;
  const scopes =
    declared === undefined
      ? undefined
      : declared.split(",").map((entry) => entry.trim());
  const apiKey = environment.DAYKEEPER_API_KEY;
  const accessToken = environment.DAYKEEPER_ACCESS_TOKEN;
  if ((apiKey === undefined) === (accessToken === undefined))
    throw invalidConfig();
  const options: DaykeeperMcpOptions = {
    baseUrl: environment.DAYKEEPER_API_URL ?? "",
    ...(apiKey !== undefined ? { apiKey } : { accessToken: accessToken! }),
    timeoutMs: timeout === undefined ? undefined : Number(timeout),
    enablePlanning: flag("DAYKEEPER_MCP_ENABLE_PLANNING"),
    enableMutations: flag("DAYKEEPER_MCP_ENABLE_MUTATIONS"),
    enableFlowWrites: flag("DAYKEEPER_MCP_ENABLE_FLOW_WRITES"),
    enableInboxTools: flag("DAYKEEPER_MCP_ENABLE_INBOX_TOOLS"),
    enableActivationTools: flag("DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS"),
    enableOperatorTools: flag("DAYKEEPER_MCP_ENABLE_OPERATOR_TOOLS"),
    enableOperatorWrites: flag("DAYKEEPER_MCP_ENABLE_OPERATOR_WRITES"),
    ...(scopes === undefined ? {} : { scopes }),
  };
  const config = validateOptions(options);
  return Object.freeze({
    baseUrl: config.baseUrl,
    ...(config.credentialMode === "api_key"
      ? { apiKey: config.accessToken }
      : { accessToken: config.accessToken }),
    timeoutMs: config.timeoutMs,
    enablePlanning: config.enablePlanning,
    enableMutations: config.enableMutations,
    enableFlowWrites: config.enableFlowWrites,
    enableInboxTools: config.enableInboxTools,
    enableActivationTools: config.enableActivationTools,
    enableOperatorTools: config.enableOperatorTools,
    enableOperatorWrites: config.enableOperatorWrites,
    ...(config.scopes === undefined ? {} : { scopes: config.scopes }),
  });
}

function normalizeScopes(
  scopes: readonly string[] | undefined,
): readonly string[] | undefined {
  if (scopes === undefined) return undefined;
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES)
    throw invalidConfig();
  for (const scope of scopes) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope))
      throw invalidConfig();
  }
  return Object.freeze([...new Set(scopes)].sort());
}

function invalidConfig(): McpAdapterError {
  return new McpAdapterError(
    "INVALID_CONFIGURATION",
    "Configure a valid Daykeeper API URL, exactly one scoped API key or OAuth access token, and explicit optional feature flags. Configuration values are not logged.",
  );
}
