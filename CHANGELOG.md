# Changelog

## Unreleased

### Changed

- The hosted dashboard's `send_reply` tool now sets `openWorldHint: true`,
  because a sent reply reaches a customer outside Daykeeper. The other nine
  dashboard tools keep `openWorldHint: false`.

## 0.5.0 - 2026-10-17

Consumes the Daykeeper MANAGEMENT contract 1.12.0 (tag `v1.12.0`, additive)
via `@skyporch/daykeeper` 0.7.0. See `COMPATIBILITY.md` for the contract tag
and commit. Open claims need a server with migration 0122
(SkyPorch/daykeeper#314).

### Added

- `daykeeper_workspace_claims_create` takes `email` as optional. Without it the
  tool issues an open claim link that whoever opens it first may accept, and
  its message says so. A replay of an open claim somebody already accepted
  reports who owns the workspace now.

### Changed

- Claim messages open with what happens until the workspace is claimed:
  customer messages reach only the agent and nobody is emailed about them.
- Server instructions tell the agent to hand its person a claim link when the
  workspace is unclaimed, preferring the person's address when it was given.
- Claims read back with a nullable `email`.
- Claim tools need `@skyporch/daykeeper` 0.7.0 (`requiredClaimSdkVersion`):
  an injected client from 0.3-0.6 has the same claim methods but cannot issue
  open claims, so it is now refused (`SDK_TOO_OLD`) instead of advertised as
  supported. The gate reads `workspaceClaims.openClaims` and never sends a
  request.

## 0.4.0 - 2026-10-12

### Added

- Opt-in hosted Dashboard MCP (`daykeeper-dashboard-mcp`, off unless
  `DAYKEEPER_DASHBOARD_MCP_ENABLED=true`) with connection-bound profile,
  workspace, tenant readiness and usage tools; bounded conversation browsing;
  replies, status changes and customer-email settings. OAuth discovery
  metadata, data-free sign-in challenges before a token exists, and
  read-permission checks before the inbox opens.
- A Daykeeper Dashboard App resource on `show_dashboard` only. The existing
  local MCP tools and stdio entry point are unchanged.
- A dashboard reply requires a caller-supplied UUID `requestId`, preserved for
  retries after an uncertain result.

### Contract

- Consumes the Daykeeper MANAGEMENT contract 1.9.0 (tag `v1.9.0`, additive)
  via `@skyporch/daykeeper` 0.6.0. See `COMPATIBILITY.md` for the contract tag
  and commit. The hosted dashboard needs a server implementing 1.9.0
  (SkyPorch/daykeeper#313); it refuses to start, and its tools answer
  `SDK_TOO_OLD`, with an older SDK. The stdio tools are unchanged.

## 0.3.0

### Contract

- Consumes the Daykeeper MANAGEMENT contract 1.3.0 (tag `v1.3.0`, additive)
  via `@skyporch/daykeeper` 0.3.0. See `COMPATIBILITY.md` for the contract tag
  and commit.

### Added

- Workspace claim tools behind `DAYKEEPER_MCP_ENABLE_CLAIM_TOOLS` (default
  off): `daykeeper_workspace_claims_create` returns the one-time claim link and
  a message to relay (who it is for, 72-hour expiry, whether Daykeeper emailed
  it), `daykeeper_workspace_claims_list` and `daykeeper_workspace_claims_revoke`.
  Create and revoke also need the mutation flag. The capabilities resource
  reports `claimToolsEnabled`, `claimSdkSupported` and
  `requiredClaimSdkVersion`.

### Changed

- `@skyporch/daykeeper` 0.3.0 (management contract `v1.3.0`, additive), which
  adds `workspaceClaims`. No existing tool changes.

## 0.2.0

### Breaking

The management contract this package consumes moves to 1.1.0, which is a
breaking contract change:

- Flow mutations now require an `Idempotency-Key` request header. The header is
  REQUIRED, not optional, so every flow create, revise and publish call must
  carry a caller-supplied key. This package surfaces that as a required
  idempotency key argument on `daykeeper_flows_create`,
  `daykeeper_flow_versions_create` and `daykeeper_flow_versions_publish`; a call
  without one is refused locally before any request is made.
- A replayed flow mutation may answer `200` alongside the original `201`. Both
  are success. This package does not replay a request on its own; an uncertain
  outcome is reported as `outcome: "unknown"` with inspect-before-retry
  guidance.

This release consumes the management contract through
`@skyporch/daykeeper@0.2.0`.

### Contract

- Consumes the Daykeeper MANAGEMENT contract 1.1.0 via
  `@skyporch/daykeeper` 0.2.0. See `COMPATIBILITY.md` for the contract tag and
  commit.

### Added

- Add candidate-gated generic inbox inspection and API-only planning without
  administrator metadata. Preserve legacy administrator-backed SDK planning.
  Reject conflicting website/API settings and applicant-supplied hosted URLs.
  These tools inspect preparation; they do not activate customer traffic.
- Add a local stdio MCP adapter over the exact published management SDK.
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
- Export a transport-neutral Streamable HTTP handler with mandatory OAuth
  verification, RFC 9728 discovery, strict Host/Origin gates, audience-bound
  short-lived tokens, verified principal/grant bindings, a pinned downstream
  API and non-elevating separate credentials. Authentication, request bodies,
  streaming responses and global/per-principal work are bounded. The package
  still deploys no listener or authorization server.

No npm release, hosted OAuth endpoint or production activation is included.
