import * as daykeeper from "@skyporch/daykeeper";
import type {
  CreateFlowInput,
  CreateFlowVersionInput,
  DaykeeperClient,
  PublishFlowVersionInput,
} from "@skyporch/daykeeper";
import { McpAdapterError } from "./errors.ts";

/**
 * The first management SDK release whose flow mutations accept an idempotency
 * key, report `replayed`, and mark an uncertain outcome. The adapter refuses to
 * start with flow writes enabled on anything older instead of writing blind.
 */
export const REQUIRED_FLOW_WRITE_SDK_VERSION = "0.2.0";

/**
 * Local structural shim for the idempotent flow surface. The adapter compiles
 * against the pinned registry SDK, which still exposes key-less flow mutations,
 * so these signatures are declared here rather than imported. They mirror the
 * candidate SDK exactly; nothing here relaxes a runtime check.
 */
export interface FlowMutationResultShim {
  readonly flow: Readonly<Record<string, unknown>>;
  readonly version: Readonly<Record<string, unknown>>;
  /** True when the server returned the stored result of an earlier identical request. */
  readonly replayed: boolean;
}

export interface IdempotencyOptionsShim {
  readonly idempotencyKey: string;
}

export interface IdempotentFlowsApi {
  create(
    tenantId: string,
    input: CreateFlowInput,
    options: IdempotencyOptionsShim,
  ): Promise<FlowMutationResultShim>;
  createVersion(
    flowId: string,
    input: CreateFlowVersionInput,
    options: IdempotencyOptionsShim,
  ): Promise<FlowMutationResultShim>;
  publishVersion(
    flowId: string,
    version: number,
    input: PublishFlowVersionInput,
    options: IdempotencyOptionsShim,
  ): Promise<FlowMutationResultShim>;
}

/**
 * `generateIdempotencyKey` is exported only by an SDK whose flow mutations
 * require a caller-supplied key, so its presence is the capability probe. The
 * adapter never calls it: keys are supplied by the caller, one per intended
 * mutation.
 */
export function sdkSupportsFlowWrites(
  module: Readonly<Record<string, unknown>> = daykeeper as unknown as Readonly<
    Record<string, unknown>
  >,
): boolean {
  return typeof module.generateIdempotencyKey === "function";
}

export function assertFlowWriteSdk(
  module?: Readonly<Record<string, unknown>>,
): void {
  if (sdkSupportsFlowWrites(module)) return;
  throw new McpAdapterError(
    "SDK_TOO_OLD",
    `Flow writes require @skyporch/daykeeper ${REQUIRED_FLOW_WRITE_SDK_VERSION} or newer, whose flow mutations accept an idempotency key and report an uncertain outcome. The installed SDK does not, so DAYKEEPER_MCP_ENABLE_FLOW_WRITES must stay false until it is upgraded.`,
  );
}

/** Never widens authorization; it only exposes the key-carrying signatures. */
export function idempotentFlows(client: DaykeeperClient): IdempotentFlowsApi {
  assertFlowWriteSdk();
  return client.flows as unknown as IdempotentFlowsApi;
}

/**
 * True when the SDK reported that the server may already have applied the
 * mutation. Recovery is inspection, never a fresh key.
 */
export function isOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}

export function isIdempotencyKeyReused(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "IDEMPOTENCY_KEY_REUSED"
  );
}
