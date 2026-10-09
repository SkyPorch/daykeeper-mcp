import type { DashboardOAuthMetric } from "./dashboardHosted.ts";
import type { DaykeeperDiscoveryMetric } from "./http.ts";
import type { DashboardToolMetric } from "./dashboardServer.ts";

const toolNames = [
  "get_profile",
  "list_workspaces",
  "get_dashboard",
  "list_conversations",
  "get_conversation",
  "send_reply",
  "set_conversation_status",
  "get_customer_email",
  "set_customer_email",
  "show_dashboard",
] as const;
const discoveryOperations = [
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
] as const satisfies readonly DaykeeperDiscoveryMetric["operation"][];

type OutcomeCounts = { success: number; failure: number };
type ToolCounts = {
  success: number;
  unknown: number;
  failure: number;
  latencyMsTotal: number;
  latencyMsMax: number;
};
type DiscoveryCounts = {
  success: number;
  failure: number;
  latencyMsTotal: number;
  latencyMsMax: number;
};

/** In-memory aggregate metrics only; no identity, credential, or tool data. */
export class DashboardMetrics {
  readonly #intervalStartedAt = new Date();
  readonly #oauth: Record<DashboardOAuthMetric["operation"], OutcomeCounts> = {
    introspection: { success: 0, failure: 0 },
    exchange: { success: 0, failure: 0 },
  };
  readonly #tools: Record<(typeof toolNames)[number], ToolCounts> =
    Object.fromEntries(
      toolNames.map((name) => [
        name,
        {
          success: 0,
          unknown: 0,
          failure: 0,
          latencyMsTotal: 0,
          latencyMsMax: 0,
        },
      ]),
    ) as Record<(typeof toolNames)[number], ToolCounts>;
  readonly #discovery: Record<
    (typeof discoveryOperations)[number],
    DiscoveryCounts
  > = Object.fromEntries(
    discoveryOperations.map((operation) => [
      operation,
      { success: 0, failure: 0, latencyMsTotal: 0, latencyMsMax: 0 },
    ]),
  ) as Record<(typeof discoveryOperations)[number], DiscoveryCounts>;
  readonly #replyOutcomes = { sent: 0, unknown: 0, failed: 0 };
  #activeHttpConnections = 0;

  setActiveHttpConnections(count: number): void {
    if (Number.isSafeInteger(count) && count >= 0)
      this.#activeHttpConnections = count;
  }

  recordOAuth(metric: DashboardOAuthMetric): void {
    this.#oauth[metric.operation][metric.outcome]++;
  }

  recordTool(metric: DashboardToolMetric): void {
    if (!(toolNames as readonly string[]).includes(metric.tool)) return;
    const tool = this.#tools[metric.tool as (typeof toolNames)[number]];
    tool[metric.outcome]++;
    const durationMs = Math.min(120_000, Math.max(0, metric.durationMs));
    tool.latencyMsTotal += durationMs;
    tool.latencyMsMax = Math.max(tool.latencyMsMax, durationMs);
    if (metric.tool === "send_reply") {
      this.#replyOutcomes[
        metric.outcome === "success"
          ? "sent"
          : metric.outcome === "unknown"
            ? "unknown"
            : "failed"
      ]++;
    }
  }

  recordDiscovery(metric: DaykeeperDiscoveryMetric): void {
    if (!(discoveryOperations as readonly string[]).includes(metric.operation))
      return;
    const operation =
      this.#discovery[metric.operation as (typeof discoveryOperations)[number]];
    operation[metric.outcome]++;
    const durationMs = Math.min(120_000, Math.max(0, metric.durationMs));
    operation.latencyMsTotal += durationMs;
    operation.latencyMsMax = Math.max(operation.latencyMsMax, durationMs);
  }

  flush(): void {
    const intervalEndedAt = new Date();
    const record = {
      event: "daykeeper_dashboard_metrics",
      intervalStartedAt: this.#intervalStartedAt.toISOString(),
      intervalEndedAt: intervalEndedAt.toISOString(),
      activeHttpConnections: this.#activeHttpConnections,
      oauth: {
        introspection: { ...this.#oauth.introspection },
        exchange: { ...this.#oauth.exchange },
        grantsValidated: this.#oauth.introspection.success,
      },
      discovery: Object.fromEntries(
        discoveryOperations.map((operation) => [
          operation,
          { ...this.#discovery[operation] },
        ]),
      ),
      tools: Object.fromEntries(
        toolNames.map((name) => [name, { ...this.#tools[name] }]),
      ),
      replyOutcomes: { ...this.#replyOutcomes },
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
    this.#intervalStartedAt.setTime(intervalEndedAt.getTime());
    for (const stage of Object.values(this.#oauth)) {
      stage.success = 0;
      stage.failure = 0;
    }
    for (const counts of Object.values(this.#tools)) {
      counts.success = 0;
      counts.unknown = 0;
      counts.failure = 0;
      counts.latencyMsTotal = 0;
      counts.latencyMsMax = 0;
    }
    for (const counts of Object.values(this.#discovery)) {
      counts.success = 0;
      counts.failure = 0;
      counts.latencyMsTotal = 0;
      counts.latencyMsMax = 0;
    }
    this.#replyOutcomes.sent = 0;
    this.#replyOutcomes.unknown = 0;
    this.#replyOutcomes.failed = 0;
  }
}
