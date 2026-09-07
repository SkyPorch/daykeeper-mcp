import { DaykeeperClient } from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

export const REQUIRED_ACTIVATION_SDK_VERSION = "0.2.0";

export interface ActivationSdk {
  inboxActivations: {
    create(
      tenantId: string,
      options: { idempotencyKey: string; signal?: AbortSignal },
    ): Promise<unknown>;
    get(
      tenantId: string,
      intent: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    revoke(
      tenantId: string,
      intent: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

/** Constructor-only local probe. It never dispatches and does not authorize API calls. */
export function sdkSupportsActivationTools(value?: unknown): boolean {
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
    ) as Partial<ActivationSdk>;
    return (
      typeof client?.inboxActivations?.create === "function" &&
      typeof client?.inboxActivations?.get === "function" &&
      typeof client?.inboxActivations?.revoke === "function"
    );
  } catch {
    return false;
  }
}

export function assertActivationSdk(value?: unknown): void {
  if (!sdkSupportsActivationTools(value))
    throw new McpAdapterError(
      "SDK_TOO_OLD",
      `Inbox activation tools require @skyporch/daykeeper ${REQUIRED_ACTIVATION_SDK_VERSION} or newer with inboxActivations create/get/revoke support. Keep DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS false until the reviewed SDK is installed.`,
    );
}

export function activationSdk(client: DaykeeperClient): ActivationSdk {
  assertActivationSdk(client);
  return client as unknown as ActivationSdk;
}
