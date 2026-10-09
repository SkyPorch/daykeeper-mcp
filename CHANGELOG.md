# Changelog

## Unreleased

### Added

- Daykeeper Dashboard tool profile (`toolProfile: "dashboard"`): exactly ten
  ChatGPT-facing tools (`get_profile`, `list_workspaces`, `get_dashboard`,
  `list_conversations`, `get_conversation`, `send_reply`,
  `set_conversation_status`, `get_customer_email`, `set_customer_email`,
  `show_dashboard`) with per-tool input/output schemas and annotations. The
  profile replaces the general catalog; no general flag adds tools to it.
- Dashboard UI resource `ui://daykeeper/dashboard-v1.html`
  (`text/html;profile=mcp-app`), attached only to `show_dashboard`. It is
  self-contained, makes no network requests and calls the same tools through
  the MCP Apps bridge.
- Pass-through credential mode for the HTTP handler
  (`downstreamCredential: "passthrough"`), an explicit opt-in that forwards the
  verified bearer to the API. Exchange mode stays the default.
- `createDaykeeperIntrospectionVerifier`: RFC 7662 token verifier with a
  timeout, response size cap, strict schema and a positive-only cache of at
  most 30 s (never past `exp`).
- `startDaykeeperMcpHttpServer` and the `daykeeper-mcp-http` bin: the hosted
  ChatGPT endpoint, configured from `DAYKEEPER_MCP_*`, `DAYKEEPER_INTERNAL_API_URL`
  and `DAYKEEPER_OAUTH_*` environment variables, with `/healthz` and graceful
  shutdown.

- Pass-through mode forwards the proxy's `X-Forwarded-For` (bare IP literals,
  at most 8 entries and 512 characters; anything else is dropped) to every API
  call on an allowlisted internal host, so per-client rate limits see the
  person. Exchange mode never forwards it.
- A tool whose API call is refused with 401 carries
  `_meta["mcp/www_authenticate"]` (`error="invalid_token"` plus
  `error_description`), so ChatGPT prompts the person to reconnect.

- Introspection remembers `active: false` answers for 5 minutes (bounded,
  keyed by token digest); malformed answers and outages are never cached.
- `preAuthRateLimit`: a per-client-address budget for failed authentications,
  checked before the verifier, so random-bearer floods never reach
  introspection. The hosted server enables it (30, then one per 2 s).
- `trustedProxies` / `DAYKEEPER_MCP_TRUSTED_PROXIES`: `X-Forwarded-For` is
  honoured only from these peers (default private ranges and loopback).

### Changed

- The hosted server drains on shutdown: it stops accepting, waits up to 10 s
  for in-flight requests, then cancels the rest. Request targets containing
  `\` or resolving to another origin are refused.
- The dashboard UI keeps a reply's idempotency key after any uncertain
  failure (timeout, bridge error, `REQUEST_IN_PROGRESS`, unknown outcome) and
  releases it only on success or a definite refusal.
- The hosted entrypoint requires `DAYKEEPER_MCP_WIDGET_DOMAIN` (OpenAI
  requires `_meta.ui.domain` to submit a plugin with UI).
- `list_conversations` accepts `open`, `resolved`, `pending`, `snoozed` or
  `all` and always sends `status` (cursors are bound to it). `send_reply`
  reports `replayed` from the `idempotent-replayed` header and explains
  `REQUEST_IN_PROGRESS`, `REQUEST_OUTCOME_UNKNOWN` and `IDEMPOTENCY_KEY_REUSED`.
  An API error that says `outcomeUnknown` marks any write's outcome unknown.
- The HTTP handler can stop serving `/.well-known/oauth-authorization-server`
  (`serveAuthorizationServerMetadata: false`) and accept just the issuer
  (`authorizationServerIssuer`). The default is unchanged.
- A request with no credentials gets a bare `Bearer resource_metadata="…"`
  challenge (RFC 6750 3.1); an unusable token still gets `invalid_token`.
- A verifier that throws `DaykeeperMcpVerifierUnavailableError` produces 503
  instead of a 401 re-authorization challenge.

### Fixed

- Hosted principals kept every feature gate except `enableClaimTools`, which
  was silently dropped.

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
