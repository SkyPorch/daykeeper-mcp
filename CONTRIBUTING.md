# Contributing

Every MCP tool wraps a typed `@skyporch/daykeeper` method. Do not add arbitrary
HTTP calls or tools that reach past the SDK surface.

Tools are read-first: a new write tool needs an explicit scope, an idempotency
story, and a test. Never log or return API keys, tokens, or provider response
bodies.

HTTP changes must preserve exact Host/Origin validation, RFC 8707 audience
binding, finite token expiry, verified principal/grant identity, a pinned API
origin, non-elevating separate downstream credentials, reject-fast auth/request
concurrency and actual stream byte bounds. The command must remain stdio-only
unless a separate security review approves a listener.

Examples, fixtures, and documentation must stay synthetic: no real tenant
names, customer data, hostnames, or downstream product names.

Run the repository's checks before requesting review.
