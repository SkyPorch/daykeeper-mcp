import { DaykeeperClient } from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

export const REQUIRED_CLAIM_SDK_VERSION = "0.3.0";

export interface ClaimSdk {
  workspaceClaims: {
    create(
      input: { email: string },
      options: { idempotencyKey: string; signal?: AbortSignal },
    ): Promise<unknown>;
    list(options?: { signal?: AbortSignal }): Promise<unknown>;
    revoke(
      claimId: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
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
      typeof client?.workspaceClaims?.revoke === "function"
    );
  } catch {
    return false;
  }
}

export function assertClaimSdk(value?: unknown): void {
  if (!sdkSupportsClaimTools(value))
    throw new McpAdapterError(
      "SDK_TOO_OLD",
      `Workspace claim tools require @skyporch/daykeeper ${REQUIRED_CLAIM_SDK_VERSION} or newer with workspaceClaims create/list/revoke support. Keep DAYKEEPER_MCP_ENABLE_CLAIM_TOOLS false until the reviewed SDK is installed.`,
    );
}

export function claimSdk(client: DaykeeperClient): ClaimSdk {
  assertClaimSdk(client);
  return client as unknown as ClaimSdk;
}
