# MCP onboarding aggregate handoff

Aggregate branch `codex/daykeeper-mcp-release-aggregate` is based on current
`main` and preserves the reviewed candidate stack through MCP #25.

## Implemented

- Explicit `enableInboxTools` option / `DAYKEEPER_MCP_ENABLE_INBOX_TOOLS` flag,
  forwarded through validated hosted downstream principal configuration.
- Two read tools for website channel and tenant provisioning operation inspection.
- A separately planning-gated website inbox tenant-plan tool, followed by the
  existing exact-plan apply workflow and its independent mutation gate.
- SDK structural capability check before server startup/dispatch; no invented
  HTTP requests, no constructor probe network access or caller credentials.
- Local metadata reports the new gates. Default eight reads remain unchanged;
  the three new tools are hidden and inaccessible until explicitly enabled.
- CI pins Node SDK source commit
  `c9d67753465af85f46a0f473ffdc77bd6bd80320`, packs it and runs the entire MCP
  test suite in an isolated consumer with zero skips. The five flow, five inbox,
  and four activation candidate dispatch cases are mandatory. Release dependency
  and lock remain 0.1.0.

## Boundaries and remaining work

No package publication, dependency upgrade, merge, deployment or live account
mutation was performed. The package remains private/unpublished. Existing
`.npm-cache/` is unrelated untracked local state and was left untouched.

Tests use injected API responses, not the production management API or provider.
The platform's separate PostgreSQL/compiled-service journey is not proof that this
MCP adapter has completed live onboarding. A deployment rehearsal must still join
the protected signup credential flow, MCP planning/apply/status, durable traffic
activation and a real customer exchange. Never return an owner private key or
signup credential into a tool transcript as a shortcut for protected custody.

Website DNS evidence, self-serve activation and hosted OAuth authorization-server
setup remain separate work. API-only versus website-first activation is awaiting
the owner's product choice; these inspection/planning tools do not choose it.
Billing remains paused. Do not equate `prepared` or a succeeded operation with
`trafficEnabled` or verified end-user delivery.

Release approval must separately review and publish the required SDK version,
update the MCP release dependency/lockfile and version, then pass cold/package
checks and the existing publication guards. Do not enable candidate-only tools
with the current 0.1.0 release SDK or claim that installing it enables them.

## Validation

`pnpm check` passed against the pinned release SDK: 138 tests ran, with 14
candidate-only dispatches skipped as expected, plus build, modern/legacy stdio
smoke and reproducible packed-package checks. Against the isolated trusted SDK
tarball, the candidate suite must pass with zero skips, including the five flow,
five inbox and four activation dispatch cases. The aggregate PR records the
candidate artifact and source provenance; the release manifest remains 0.1.0.
The release manifest and lockfile were unchanged. Direct/independent focused
review found no remaining production issue; source-exporting review commands
were not run under the owner restriction. Local execution used Node v25.6.1;
hosted CI additionally targets Node 20, 22 and 24.
