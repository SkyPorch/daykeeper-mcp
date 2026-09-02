# Changelog

## 0.1.0 (unreleased)

- Add a private, local stdio MCP adapter over the exact published management SDK.
- Add eight read tools and separately gated planning and mutation tools.
- Preserve plan/version/idempotency boundaries with no automatic request replay.
- Add structured, redacted results, bounded transport, cancellation and concurrency.
- Accept exactly one `DAYKEEPER_API_KEY` for static headless use or
  `DAYKEEPER_ACCESS_TOKEN` for OAuth, with no credential arguments or fallback.
- Verify modern/legacy MCP clients and the actual packed executable without live credentials.

No npm release, hosted OAuth endpoint or production activation is included.
