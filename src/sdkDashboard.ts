import { DaykeeperClient } from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

/**
 * The hosted dashboard needs the SDK methods added for management contract
 * 1.9.0. The release dependency stays on the published SDK until that SDK is
 * released; CI's sdk-candidate job exercises the dashboard against it.
 */
export const REQUIRED_DASHBOARD_SDK_VERSION = "0.6.0";

type Signal = { signal?: AbortSignal };
type Page = Signal & { cursor?: string; limit?: number };

export interface DashboardSdk {
  profile: { get(options?: Signal): Promise<unknown> };
  workspaces: { list(options?: Signal): Promise<unknown> };
  customerEmail: {
    get(tenantId: string, options?: Signal): Promise<unknown>;
    set(
      tenantId: string,
      input: { enabled: boolean },
      options?: Signal,
    ): Promise<unknown>;
  };
  operatorConversations: {
    list(tenantId: string, options?: Page): Promise<unknown>;
    get(tenantId: string, id: number, options?: Signal): Promise<unknown>;
    messages(tenantId: string, id: number, options?: Page): Promise<unknown>;
    reply(
      tenantId: string,
      id: number,
      content: string,
      options?: Signal & { requestId?: string },
    ): Promise<unknown>;
    setStatus(
      tenantId: string,
      id: number,
      input: { status: "open" | "resolved" },
      options?: Signal,
    ): Promise<unknown>;
  };
}

/** Constructor-only local probe. It never dispatches and does not authorize API calls. */
export function sdkSupportsDashboard(value?: unknown): boolean {
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
    ) as Partial<DashboardSdk>;
    return (
      typeof client?.profile?.get === "function" &&
      typeof client?.workspaces?.list === "function" &&
      typeof client?.customerEmail?.get === "function" &&
      typeof client?.customerEmail?.set === "function" &&
      typeof client?.operatorConversations?.list === "function" &&
      typeof client.operatorConversations.get === "function" &&
      typeof client.operatorConversations.messages === "function" &&
      typeof client.operatorConversations.reply === "function" &&
      typeof client.operatorConversations.setStatus === "function"
    );
  } catch {
    return false;
  }
}

export function assertDashboardSdk(value?: unknown): void {
  if (!sdkSupportsDashboard(value))
    throw new McpAdapterError(
      "SDK_TOO_OLD",
      `The hosted Daykeeper Dashboard requires @skyporch/daykeeper ${REQUIRED_DASHBOARD_SDK_VERSION} or newer with profile, workspaces, customerEmail, and paged operator conversation support.`,
    );
}

export function dashboardSdk(client: DaykeeperClient): DashboardSdk {
  assertDashboardSdk(client);
  return client as unknown as DashboardSdk;
}
