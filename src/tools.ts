import {
  DaykeeperApiError,
  DaykeeperTransportError,
  type DaykeeperClient,
} from "@skyporch/daykeeper";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const id = z.string().uuid();
const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const tenantSpec = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  locale: z.string().trim().min(2).max(35),
  region: z.string().trim().min(2).max(35).optional(),
  supportEmail: z.string().email().max(254).optional(),
  administrator: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().email().max(254),
  }),
});

const emailChannelSpec = z.object({
  address: z.string().email().max(254),
  region: z
    .enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"])
    .optional(),
});

const flowCondition = z.object({
  field: z.enum(["contact.email_domain", "conversation.tag", "message.text"]),
  operator: z.enum(["equals", "contains", "ends_with"]),
  value: z.string().trim().min(1).max(500),
});

const flowAction = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("reply"),
    text: z.string().trim().min(1).max(4000),
  }),
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("tag"),
    tag: z.string().trim().min(1).max(64),
  }),
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("handoff"),
    target: z.enum(["agent", "human", "hybrid"]),
  }),
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("set_priority"),
    priority: z.enum(["low", "medium", "high", "urgent"]),
  }),
]);

const flowDefinition = z.object({
  schemaVersion: z.literal("2026-08-01"),
  trigger: z.object({
    event: z.enum(["conversation.created", "message.received"]),
    channel: z.literal("email"),
  }),
  conditions: z.array(flowCondition).max(20),
  actions: z.array(flowAction).min(1).max(25),
});

export interface DaykeeperMcpOptions {
  allowMutations?: boolean;
  allowUnsafeFlowMutations?: boolean;
}

export interface DaykeeperToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  execute(input: unknown): Promise<unknown>;
}

export function daykeeperToolDefinitions(
  client: DaykeeperClient,
  options: DaykeeperMcpOptions = {},
): DaykeeperToolDefinition[] {
  const tools: DaykeeperToolDefinition[] = [
    tool({
      name: "daykeeper_get_capabilities",
      title: "Get Daykeeper capabilities",
      description:
        "Inspect enabled Daykeeper API features and schema versions. Makes no changes.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
      execute: () => client.capabilities(),
    }),
    tool({
      name: "daykeeper_list_tenants",
      title: "List Daykeeper tenants",
      description:
        "List tenants visible to the caller's organization and tenant scopes.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
      execute: () => client.tenants.list(),
    }),
    tool({
      name: "daykeeper_get_tenant",
      title: "Get a Daykeeper tenant",
      description: "Read one tenant's desired and observed state.",
      inputSchema: z.object({ tenantId: id }),
      annotations: readOnlyAnnotations,
      execute: (input) => {
        const { tenantId } = z.object({ tenantId: id }).parse(input);
        return client.tenants.get(tenantId);
      },
    }),
    tool({
      name: "daykeeper_plan_tenant",
      title: "Plan a Daykeeper tenant",
      description:
        "Validate and record a short-lived tenant creation plan. Does not create provider resources.",
      inputSchema: tenantSpec,
      annotations: planAnnotations,
      execute: (input) => client.tenants.plan(tenantSpec.parse(input)),
    }),
    tool({
      name: "daykeeper_get_email_channel",
      title: "Get a Daykeeper email channel",
      description:
        "Read email-channel DNS records, provider state, and round-trip evidence.",
      inputSchema: z.object({ tenantId: id }),
      annotations: readOnlyAnnotations,
      execute: (input) => {
        const { tenantId } = z.object({ tenantId: id }).parse(input);
        return client.emailChannels.get(tenantId);
      },
    }),
    tool({
      name: "daykeeper_plan_email_channel",
      title: "Plan a Daykeeper email channel",
      description:
        "Validate and record a short-lived email-channel plan and required DNS changes.",
      inputSchema: z.object({
        tenantId: id,
        spec: emailChannelSpec,
      }),
      annotations: planAnnotations,
      execute: (input) => {
        const parsed = z
          .object({ tenantId: id, spec: emailChannelSpec })
          .parse(input);
        return client.emailChannels.plan(parsed.tenantId, parsed.spec);
      },
    }),
    tool({
      name: "daykeeper_get_operation",
      title: "Get a Daykeeper operation",
      description:
        "Inspect durable operation state, bounded step failures, and next actions.",
      inputSchema: z.object({ operationId: id }),
      annotations: readOnlyAnnotations,
      execute: (input) => {
        const { operationId } = z.object({ operationId: id }).parse(input);
        return client.operations.get(operationId);
      },
    }),
    tool({
      name: "daykeeper_list_flows",
      title: "List Daykeeper flows",
      description: "List versioned flow metadata, optionally for one tenant.",
      inputSchema: z.object({ tenantId: id.optional() }),
      annotations: readOnlyAnnotations,
      execute: (input) => {
        const { tenantId } = z.object({ tenantId: id.optional() }).parse(input);
        return client.flows.list(tenantId);
      },
    }),
    tool({
      name: "daykeeper_get_flow",
      title: "Get a Daykeeper flow",
      description: "Read a flow and its latest immutable definition.",
      inputSchema: z.object({ flowId: id }),
      annotations: readOnlyAnnotations,
      execute: (input) => {
        const { flowId } = z.object({ flowId: id }).parse(input);
        return client.flows.get(flowId);
      },
    }),
    tool({
      name: "daykeeper_get_flow_version",
      title: "Get a Daykeeper flow version",
      description: "Read one immutable, content-addressed flow version.",
      inputSchema: z.object({
        flowId: id,
        version: z.number().int().positive(),
      }),
      annotations: readOnlyAnnotations,
      execute: (input) => {
        const parsed = z
          .object({ flowId: id, version: z.number().int().positive() })
          .parse(input);
        return client.flows.getVersion(parsed.flowId, parsed.version);
      },
    }),
  ];

  if (options.allowMutations) {
    tools.push(
      tool({
        name: "daykeeper_apply_tenant_plan",
        title: "Apply a Daykeeper tenant plan",
        description:
          "Create provider resources from a fresh reviewed plan. Requires an idempotency key and returns a durable operation.",
        inputSchema: z.object({
          planId: id,
          planVersion: z.number().int().positive(),
          idempotencyKey,
        }),
        annotations: applyAnnotations,
        execute: (input) => {
          const parsed = z
            .object({
              planId: id,
              planVersion: z.number().int().positive(),
              idempotencyKey,
            })
            .parse(input);
          return client.tenants.apply(
            { planId: parsed.planId, planVersion: parsed.planVersion },
            { idempotencyKey: parsed.idempotencyKey },
          );
        },
      }),
      tool({
        name: "daykeeper_apply_email_channel_plan",
        title: "Apply a Daykeeper email-channel plan",
        description:
          "Provision an email channel from a fresh reviewed plan. Requires an idempotency key and returns a durable operation.",
        inputSchema: z.object({
          planId: id,
          planVersion: z.number().int().positive(),
          idempotencyKey,
        }),
        annotations: applyAnnotations,
        execute: (input) => {
          const parsed = z
            .object({
              planId: id,
              planVersion: z.number().int().positive(),
              idempotencyKey,
            })
            .parse(input);
          return client.emailChannels.apply(
            { planId: parsed.planId, planVersion: parsed.planVersion },
            { idempotencyKey: parsed.idempotencyKey },
          );
        },
      }),
      tool({
        name: "daykeeper_retry_operation",
        title: "Retry a Daykeeper operation",
        description:
          "Retry only an operation the API has classified as failed and retryable.",
        inputSchema: z.object({ operationId: id }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        execute: (input) => {
          const { operationId } = z.object({ operationId: id }).parse(input);
          return client.operations.retry(operationId);
        },
      }),
    );
  }

  if (options.allowUnsafeFlowMutations) {
    tools.push(
      tool({
        name: "daykeeper_create_flow",
        title: "Create a Daykeeper flow",
        description:
          "Create a draft flow and immutable first version. This API is not idempotent; require external human approval.",
        inputSchema: z.object({
          tenantId: id,
          name: z.string().trim().min(2).max(120),
          slug: z
            .string()
            .min(1)
            .max(63)
            .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
          description: z.string().trim().min(1).max(500).optional(),
          definition: flowDefinition,
        }),
        annotations: unsafeMutationAnnotations,
        execute: (input) => {
          const parsed = z
            .object({
              tenantId: id,
              name: z.string().trim().min(2).max(120),
              slug: z
                .string()
                .min(1)
                .max(63)
                .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
              description: z.string().trim().min(1).max(500).optional(),
              definition: flowDefinition,
            })
            .parse(input);
          return client.flows.create(parsed.tenantId, {
            name: parsed.name,
            slug: parsed.slug,
            description: parsed.description,
            definition: parsed.definition,
          });
        },
      }),
      tool({
        name: "daykeeper_create_flow_version",
        title: "Create a Daykeeper flow version",
        description:
          "Create the next immutable flow version with optimistic concurrency. This API is not idempotent.",
        inputSchema: z.object({
          flowId: id,
          expectedLatestVersion: z.number().int().positive(),
          definition: flowDefinition,
        }),
        annotations: unsafeMutationAnnotations,
        execute: (input) => {
          const parsed = z
            .object({
              flowId: id,
              expectedLatestVersion: z.number().int().positive(),
              definition: flowDefinition,
            })
            .parse(input);
          return client.flows.createVersion(parsed.flowId, {
            expectedLatestVersion: parsed.expectedLatestVersion,
            definition: parsed.definition,
          });
        },
      }),
      tool({
        name: "daykeeper_publish_flow_version",
        title: "Publish a Daykeeper flow version",
        description:
          "Publish reviewed desired state with optimistic concurrency. Flow execution is currently management-only.",
        inputSchema: z.object({
          flowId: id,
          version: z.number().int().positive(),
          expectedResourceVersion: z.number().int().positive(),
        }),
        annotations: unsafeMutationAnnotations,
        execute: (input) => {
          const parsed = z
            .object({
              flowId: id,
              version: z.number().int().positive(),
              expectedResourceVersion: z.number().int().positive(),
            })
            .parse(input);
          return client.flows.publishVersion(parsed.flowId, parsed.version, {
            expectedResourceVersion: parsed.expectedResourceVersion,
          });
        },
      }),
    );
  }

  return tools;
}

export async function executeDaykeeperTool(
  definition: DaykeeperToolDefinition,
  input: unknown,
): Promise<CallToolResult> {
  try {
    const data = await definition.execute(input);
    const structuredContent = { data } as Record<string, unknown>;
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const detail =
      error instanceof DaykeeperApiError ||
      error instanceof DaykeeperTransportError
        ? error.toJSON()
        : {
            name: "DaykeeperMcpError",
            code: "INTERNAL_ERROR",
            message: "Daykeeper MCP could not complete the tool call",
            retryable: false,
          };
    const structuredContent = { error: detail } as Record<string, unknown>;
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }
}

function tool(definition: DaykeeperToolDefinition): DaykeeperToolDefinition {
  return definition;
}

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const planAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const applyAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const unsafeMutationAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
