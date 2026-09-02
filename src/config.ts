import { McpAdapterError } from "./errors.ts";

export const MCP_VERSION = "0.1.0";
export const SDK_VERSION = "0.1.0";
export const ENVELOPE_VERSION = "1.0";
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_INPUT_BYTES = 524_288;
export const MAX_CONCURRENT_REQUESTS = 4;

interface DaykeeperMcpBaseOptions {
  baseUrl: string;
  timeoutMs?: number;
  enablePlanning?: boolean;
  enableMutations?: boolean;
  fetch?: typeof globalThis.fetch;
}

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
    for (const flag of [options.enablePlanning, options.enableMutations]) {
      if (flag !== undefined && typeof flag !== "boolean")
        throw invalidConfig();
    }
    return Object.freeze({
      baseUrl: url.href.replace(/\/$/, ""),
      accessToken: credential,
      credentialMode: hasApiKey ? "api_key" : "access_token",
      timeoutMs,
      enablePlanning: options.enablePlanning ?? false,
      enableMutations: options.enableMutations ?? false,
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
  });
}

function invalidConfig(): McpAdapterError {
  return new McpAdapterError(
    "INVALID_CONFIGURATION",
    "Configure a valid Daykeeper API URL, exactly one scoped API key or OAuth access token, and explicit optional feature flags. Configuration values are not logged.",
  );
}
