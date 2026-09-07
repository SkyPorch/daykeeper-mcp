import { DaykeeperClient, type TenantSpec } from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

export const REQUIRED_INBOX_SDK_VERSION = "0.2.0";
type InboxTenantSpec = Omit<TenantSpec, "administrator"> & {
  administrator?: TenantSpec["administrator"];
};
export interface InboxSdk {
  websiteChannels: { get(tenantId: string): Promise<unknown> };
  inboxes: { get(tenantId: string): Promise<unknown> };
  tenants: {
    plan(spec: InboxTenantSpec): Promise<unknown>;
    getProvisioningOperation(tenantId: string): Promise<unknown>;
  };
}

/** Constructor-only local probe: no credentials from the caller and no I/O.
 * Feature detection is not server authorization or a package release claim. */
export function sdkSupportsInboxTools(value?: unknown): boolean {
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
    ) as Partial<InboxSdk>;
    return (
      typeof client?.websiteChannels?.get === "function" &&
      typeof client?.inboxes?.get === "function" &&
      typeof client?.tenants?.getProvisioningOperation === "function" &&
      typeof client?.tenants?.plan === "function"
    );
  } catch {
    return false;
  }
}

export function assertInboxSdk(value?: unknown): void {
  if (!sdkSupportsInboxTools(value))
    throw new McpAdapterError(
      "SDK_TOO_OLD",
      `Inbox tools require @skyporch/daykeeper ${REQUIRED_INBOX_SDK_VERSION} or newer with generic inbox, website and provisioning inspection support. Keep DAYKEEPER_MCP_ENABLE_INBOX_TOOLS false until the reviewed SDK is installed.`,
    );
}
export function inboxSdk(client: DaykeeperClient): InboxSdk {
  assertInboxSdk(client);
  return client as unknown as InboxSdk;
}
