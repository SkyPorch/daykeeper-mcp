import { DaykeeperClient } from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

/**
 * Open claims (`create({})`, `list({ includeOpen })`) arrived in 0.7.0. The
 * claim methods of 0.3-0.6 look the same but refuse a claim without an
 * address, so the gate reads the SDK's `openClaims` marker, not the methods.
 */
export const REQUIRED_CLAIM_SDK_VERSION = "0.7.0";

export interface ClaimSdk {
  workspaceClaims: {
    create(
      // `{}` is an open claim (SDK 0.7.0, contract 1.12.0).
      input: { email?: string },
      options: { idempotencyKey: string; signal?: AbortSignal },
    ): Promise<unknown>;
    list(options?: {
      signal?: AbortSignal;
      // Lists open claims nobody accepted (SDK 0.7.0, contract 1.12.0).
      includeOpen?: boolean;
    }): Promise<unknown>;
    revoke(
      claimId: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    // Present and true from SDK 0.7.0.
    readonly openClaims?: true;
  };
}

/** Constructor-only local probe. It never dispatches and does not authorize API calls. */
export function sdkSupportsClaimTools(value?: unknown): boolean {
  try {
    const client = (
      value === undefined
        ? new DaykeeperClient({
            baseUrl: "https://sdk-probe.invalid",
            token: "daykeeper_synthetic_capability_probe",
            fetch: async () => {
              throw new Error("Capability probe must not dispatch");
            },
          })
        : value
    ) as Partial<ClaimSdk>;
    return (
      typeof client?.workspaceClaims?.create === "function" &&
      typeof client?.workspaceClaims?.list === "function" &&
      typeof client?.workspaceClaims?.revoke === "function" &&
      client.workspaceClaims.openClaims === true
    );
  } catch {
    return false;
  }
}

export function assertClaimSdk(value?: unknown): void {
  if (!sdkSupportsClaimTools(value))
    throw new McpAdapterError(
      "SDK_TOO_OLD",
      `Workspace claim tools require @skyporch/daykeeper ${REQUIRED_CLAIM_SDK_VERSION} or newer with open workspace claims (workspaceClaims.openClaims). Keep DAYKEEPER_MCP_ENABLE_CLAIM_TOOLS false until the reviewed SDK is installed.`,
    );
}

export function claimSdk(client: DaykeeperClient): ClaimSdk {
  assertClaimSdk(client);
  return client as unknown as ClaimSdk;
}
