# Changelog

## 0.1.0 (unreleased)

- Add a private, local stdio MCP adapter over the exact published management SDK.
- Add eight read tools and separately gated planning and mutation tools.
- Preserve plan/version/idempotency boundaries with no automatic request replay.
- Add structured, redacted results, bounded transport, cancellation and concurrency.
- Add gated `daykeeper_flows_create`, `daykeeper_flow_versions_create` and
  `daykeeper_flow_versions_publish`, which require both
  `DAYKEEPER_MCP_ENABLE_MUTATIONS` and `DAYKEEPER_MCP_ENABLE_FLOW_WRITES`.
- Require a caller-supplied idempotency key on every flow write, project only
  flow and version identity, and answer an uncertain outcome with
  `outcome: "unknown"` plus inspect-before-retry guidance instead of a replay.
- Refuse a tool locally when `DAYKEEPER_MCP_SCOPES` does not declare its exact
  required scope, and refuse to start when the installed SDK cannot carry a key.
- Accept exactly one `DAYKEEPER_API_KEY` for static headless use or
  `DAYKEEPER_ACCESS_TOKEN` for OAuth, with no credential arguments or fallback.
- Verify modern/legacy MCP clients and the actual packed executable without live credentials.

No npm release, hosted OAuth endpoint or production activation is included.
