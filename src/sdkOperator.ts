import { DaykeeperClient } from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

export const REQUIRED_OPERATOR_SDK_VERSION = "0.2.0";
export interface OperatorSdk {
  operatorConversations: {
    list(
      tenantId: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    messages(
      tenantId: string,
      id: number,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    reply(
      tenantId: string,
      id: number,
      content: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}
export function sdkSupportsOperatorConversations(value?: unknown): boolean {
  const client = (
    value === undefined
      ? new (DaykeeperClient as typeof DaykeeperClient)({
          baseUrl: "https://sdk-probe.invalid",
          token: "daykeeper_synthetic_capability_probe",
          fetch: async () => {
            throw new Error("Capability probe must not dispatch");
          },
        })
      : value
  ) as Partial<OperatorSdk>;
  return (
    typeof client?.operatorConversations?.list === "function" &&
    typeof client.operatorConversations.messages === "function" &&
    typeof client.operatorConversations.reply === "function"
  );
}
export function assertOperatorSdk(value?: unknown): void {
  if (!sdkSupportsOperatorConversations(value))
    throw new McpAdapterError(
      "SDK_TOO_OLD",
      `Operator conversation tools require @skyporch/daykeeper ${REQUIRED_OPERATOR_SDK_VERSION} or newer.`,
    );
}
export const operatorSdk = (client: DaykeeperClient): OperatorSdk => {
  assertOperatorSdk(client);
  return client as unknown as OperatorSdk;
};
