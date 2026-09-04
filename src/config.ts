import { McpAdapterError } from "./errors.ts";

export const MCP_VERSION = "0.1.0";
export const SDK_VERSION = "0.1.0";
export const ENVELOPE_VERSION = "1.0";
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_INPUT_BYTES = 524_288;
export const MAX_CONCURRENT_REQUESTS = 4;

export interface DaykeeperMcpOptions {
  baseUrl: string;
  accessToken: string;
  timeoutMs?: number;
  enablePlanning?: boolean;
  enableMutations?: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface DaykeeperMcpConfig {
  readonly baseUrl: string;
  readonly accessToken: string;
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
    if (
      typeof options.accessToken !== "string" ||
      options.accessToken.length < 20 ||
      options.accessToken.length > 16_384 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(options.accessToken)
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
      accessToken: options.accessToken,
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
): DaykeeperMcpConfig {
  const flag = (key: string): boolean => {
    const value = environment[key];
    if (value !== undefined && value !== "true" && value !== "false")
      throw invalidConfig();
    return value === "true";
  };
  const timeout = environment.DAYKEEPER_TIMEOUT_MS;
  if (timeout !== undefined && !/^[1-9][0-9]*$/.test(timeout))
    throw invalidConfig();
  return validateOptions({
    baseUrl: environment.DAYKEEPER_API_URL ?? "",
    accessToken: environment.DAYKEEPER_ACCESS_TOKEN ?? "",
    timeoutMs: timeout === undefined ? undefined : Number(timeout),
    enablePlanning: flag("DAYKEEPER_MCP_ENABLE_PLANNING"),
    enableMutations: flag("DAYKEEPER_MCP_ENABLE_MUTATIONS"),
  });
}

function invalidConfig(): McpAdapterError {
  return new McpAdapterError(
    "INVALID_CONFIGURATION",
    "Configure a valid Daykeeper API URL, scoped access token, and explicit optional feature flags. Configuration values are not logged.",
  );
}
