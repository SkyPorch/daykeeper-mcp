# Contributing

Every MCP tool wraps a typed `@skyporch/daykeeper` method. Do not add arbitrary
HTTP, SQL, provider, shell, or Chatwoot tools. Classify tool annotations
accurately and default new mutations off until their API authorization,
idempotency, audit, rate-limit, and approval behavior is tested.

Run `pnpm check` before review. Stdout belongs exclusively to MCP transport;
never print tokens, message bodies, provider payloads, or stack traces.
