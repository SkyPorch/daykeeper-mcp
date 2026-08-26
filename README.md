# `@skyporch/daykeeper-mcp`

The official Model Context Protocol server for safe Daykeeper administration by
agents. It wraps `@skyporch/daykeeper`; it is not a privileged back door and
does not expose arbitrary HTTP, SQL, provider, or Chatwoot tools.

## Configure

```sh
export DAYKEEPER_API_URL=https://api.daykeeper.example
export DAYKEEPER_ACCESS_TOKEN=replace-with-a-short-lived-scoped-token
```

Run `daykeeper-mcp` as a stdio MCP server. Tokens are never accepted in argv or
written to stdout. Use a different narrowly scoped credential per agent.

The default tool set is read and plan only:

- capabilities, tenant, email-channel, operation, and flow reads
- tenant and email-channel planning

To register the already-idempotent tenant/email apply tools and bounded
operation retry, set:

```sh
export DAYKEEPER_MCP_ALLOW_MUTATIONS=true
```

That switch changes discovery only; the API still enforces OAuth scopes,
tenant boundaries, plan freshness, optimistic versions, idempotency, quotas,
and audit. Flow creation/publication is intentionally absent until those
mutations gain plan/apply and idempotency semantics.

## Release status

No npm package has been published. The source is locally verified against
`@skyporch/daykeeper` commit `46ee05c`; clean-install CI waits for the reviewed
SDK `0.1.0` bootstrap. Publication remains blocked on license, history scan,
public visibility, first-package bootstrap, and trusted publishing.
