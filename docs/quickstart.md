# Quickstart

`@skyporch/daykeeper-mcp` is a stdio-only Model Context Protocol server over the
Daykeeper management API. It reads its whole configuration from the environment;
there are no credential arguments.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DAYKEEPER_API_URL` | yes | Base URL of the management API. |
| `DAYKEEPER_API_KEY` | one of | Scoped static credential for headless use. |
| `DAYKEEPER_ACCESS_TOKEN` | one of | Short-lived OAuth token supplied by the host. |
| `DAYKEEPER_MCP_ENABLE_PLANNING` | no | Exposes the planning tools. |
| `DAYKEEPER_MCP_ENABLE_MUTATIONS` | no | Exposes the mutation tools. |
| `DAYKEEPER_MCP_ENABLE_FLOW_WRITES` | no | Second gate for flow create/revise/publish. |
| `DAYKEEPER_MCP_SCOPES` | with flow writes | Comma-separated list of the exact scopes the credential holds. |
| `DAYKEEPER_TIMEOUT_MS` | no | Request timeout override, in milliseconds. |

Configure exactly one of `DAYKEEPER_API_KEY` or `DAYKEEPER_ACCESS_TOKEN`. The
server refuses to start when both or neither are set.

## Minimal MCP client configuration

Read-only, which is the default: no planning, mutation or flow-write gate is
enabled.

```json
{
  "mcpServers": {
    "daykeeper": {
      "command": "daykeeper-mcp",
      "env": {
        "DAYKEEPER_API_URL": "https://api.daykeeper.example",
        "DAYKEEPER_API_KEY": "${DAYKEEPER_API_KEY}"
      }
    }
  }
}
```

## Enabling flow writes

Flow writes need both gates plus a declared scope list, and every flow write
requires a caller-supplied idempotency key (management contract 0.2.0):

```json
"env": {
  "DAYKEEPER_API_URL": "https://api.daykeeper.example",
  "DAYKEEPER_API_KEY": "${DAYKEEPER_API_KEY}",
  "DAYKEEPER_MCP_ENABLE_MUTATIONS": "true",
  "DAYKEEPER_MCP_ENABLE_FLOW_WRITES": "true",
  "DAYKEEPER_MCP_SCOPES": "daykeeper.flows:read,daykeeper.flows:write,daykeeper.flows:publish"
}
```

Keep credentials in your host's secret store; never commit them. See `TOOLS.md`
for the full tool list and their required scopes.
