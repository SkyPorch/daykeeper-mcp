# Contributing

Every MCP tool wraps a typed `@skyporch/daykeeper` method. Do not add arbitrary
HTTP calls or tools that reach past the SDK surface.

Tools are read-first: a new write tool needs an explicit scope, an idempotency
story, and a test. Never log or return API keys, tokens, or provider response
bodies.

Examples, fixtures, and documentation must stay synthetic: no real tenant
names, customer data, hostnames, or downstream product names.

Run the repository's checks before requesting review.
