# Changelog

## 0.1.0 (unreleased)

### Breaking

The management contract this package consumes moves to 0.2.0, which is a
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

The package version stays 0.1.0 and remains private and unpublished; the break
is in the upstream contract it consumes through `@skyporch/daykeeper`.

### Contract

- Consumes the Daykeeper MANAGEMENT contract 0.2.0 via `@skyporch/daykeeper`
  0.1.0. See `COMPATIBILITY.md` for the contract tag and commit.

### Added

- Add candidate-gated generic inbox inspection and API-only planning without
  administrator metadata. Preserve legacy administrator-backed SDK planning.
  Reject conflicting website/API settings and applicant-supplied hosted URLs.
  These tools inspect preparation; they do not activate customer traffic.
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
- Export a transport-neutral Streamable HTTP handler with mandatory OAuth
  verification, RFC 9728 discovery, strict Host/Origin gates, audience-bound
  short-lived tokens, verified principal/grant bindings, a pinned downstream
  API and non-elevating separate credentials. Authentication, request bodies,
  streaming responses and global/per-principal work are bounded. The package
  still deploys no listener or authorization server.

No npm release, hosted OAuth endpoint or production activation is included.
