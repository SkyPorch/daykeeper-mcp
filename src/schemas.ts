import {
  DAYKEEPER_FLOW_SCHEMA_VERSION,
  type CreateFlowInput,
  type CreateFlowVersionInput,
  type EmailChannelSpec,
  type FlowDefinition,
  type PublishFlowVersionInput,
  type TenantSpec,
} from "@skyporch/daykeeper";
import { z } from "zod";

const text = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value.trim().length >= minimum);
const name = text(2, 120);
const slug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const email = z.email().max(254);
export const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const resourceId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .describe("Exact Daykeeper resource UUID; access is checked by the API.");
export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{16,128}$/)
  .describe(
    "A unique 16–128 character key. Preserve and reuse this same key when inspecting an uncertain apply; do not blindly replay a write.",
  );

export const tenantSpec = z.strictObject({
  name,
  slug,
  locale: text(2, 35),
  region: text(2, 35).optional(),
  supportEmail: email.optional(),
  administrator: z.strictObject({ name, email }),
}) satisfies z.ZodType<TenantSpec>;
export const emailChannelSpec = z.strictObject({
  address: email,
  region: z
    .enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"])
    .optional(),
}) satisfies z.ZodType<EmailChannelSpec>;
const flowActionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const flowAction = z.discriminatedUnion("type", [
  z.strictObject({
    id: flowActionId,
    type: z.literal("reply"),
    text: text(1, 4_000),
  }),
  z.strictObject({
    id: flowActionId,
    type: z.literal("tag"),
    tag: text(1, 120),
  }),
  z.strictObject({
    id: flowActionId,
    type: z.literal("handoff"),
    target: z.enum(["agent", "human", "hybrid"]),
  }),
  z.strictObject({
    id: flowActionId,
    type: z.literal("set_priority"),
    priority: z.enum(["low", "medium", "high", "urgent"]),
  }),
]);
export const flowDefinition = z.strictObject({
  schemaVersion: z.literal(DAYKEEPER_FLOW_SCHEMA_VERSION),
  trigger: z.strictObject({
    event: z.enum(["conversation.created", "message.received"]),
    channel: z.literal("email"),
  }),
  conditions: z
    .array(
      z.strictObject({
        field: z.enum([
          "contact.email_domain",
          "conversation.tag",
          "message.text",
        ]),
        operator: z.enum(["equals", "contains", "ends_with"]),
        value: text(1, 512),
      }),
    )
    .max(32),
  actions: z.array(flowAction).min(1).max(32),
}) satisfies z.ZodType<FlowDefinition>;

export const createFlowInput = z.strictObject({
  name,
  slug,
  description: text(1, 500).optional(),
  definition: flowDefinition,
}) satisfies z.ZodType<CreateFlowInput>;
export const createFlowVersionInput = z.strictObject({
  expectedLatestVersion: integer,
  definition: flowDefinition,
}) satisfies z.ZodType<CreateFlowVersionInput>;
export const publishFlowVersionInput = z.strictObject({
  expectedResourceVersion: integer,
}) satisfies z.ZodType<PublishFlowVersionInput>;

export const outputSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    ok: z.boolean(),
    tool: z.string(),
    effect: z.enum(["read", "plan", "mutation"]),
    data: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(z.record(z.string(), z.unknown())),
      ])
      .optional(),
    error: z
      .strictObject({
        kind: z.enum(["adapter", "api", "transport"]),
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        status: integer.optional(),
        fields: z.array(z.string()),
        nextActions: z.array(z.string()),
        correlationId: z.string().optional(),
        mutationOutcome: z.literal("unknown").optional(),
      })
      .optional(),
  })
  .refine((value) =>
    value.ok
      ? value.data !== undefined && value.error === undefined
      : value.error !== undefined && value.data === undefined,
  );
