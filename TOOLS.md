# Daykeeper MCP tool contract

Adapter envelope version 1.0; published management SDK 0.1.0. Tools pass validated
inputs to that SDK; they do not bypass the API or issue SQL/provider requests.
All inputs are strict objects. Resource identifiers are exact UUIDs and
versions are positive integers. Unknown fields are rejected before dispatch.

## Tools and required scopes

| Tool                             | Effect       | API scope                      |
| -------------------------------- | ------------ | ------------------------------ |
| `daykeeper_capabilities`         | Read         | `daykeeper.accounts:read`      |
| `daykeeper_tenants_list`         | Read         | `daykeeper.accounts:read`      |
| `daykeeper_tenants_get`          | Read         | `daykeeper.accounts:read`      |
| `daykeeper_email_channels_get`   | Read         | `daykeeper.accounts:read`      |
| `daykeeper_operations_get`       | Read         | `daykeeper.provisioning:read`  |
| `daykeeper_flows_list`           | Read         | `daykeeper.flows:read`         |
| `daykeeper_flows_get`            | Read         | `daykeeper.flows:read`         |
| `daykeeper_flow_versions_get`    | Read         | `daykeeper.flows:read`         |
| `daykeeper_tenants_plan`         | Persist plan | `daykeeper.accounts:write`     |
| `daykeeper_email_channels_plan`  | Persist plan | `daykeeper.accounts:write`     |
| `daykeeper_tenants_apply`        | Execute      | `daykeeper.provisioning:apply` |
| `daykeeper_email_channels_apply` | Execute      | `daykeeper.provisioning:apply` |
| `daykeeper_operations_retry`     | Execute      | `daykeeper.provisioning:apply` |

The first eight are enabled by default. Planning and mutation gates are
independent; enabling mutation tools does not enable plan creation. Disabled
tools are absent from `tools/list` and cannot be invoked by name. The resource
catalog still describes them so hosts can explain what is missing.

Apply requires `{planId, planVersion, idempotencyKey}`. The key is 16–128
characters drawn from letters, digits, `.`, `_`, `:`, and `-`; it is carried in
the SDK's idempotency header, not reconstructed after a failure. No helper
polls or repeats work.

Flow definitions remain readable. Creation, revision and publication are not
MCP tools until those API writes accept idempotency keys and define durable
inspect-after-timeout behavior. A management flow is not proof that a runtime
will execute it; inspect API capabilities before claiming execution.

## Result envelope

Successful dispatched tools return `structuredContent` with this shape and
equivalent JSON text for older clients:

```json
{
  "schemaVersion": "1.0",
  "ok": true,
  "tool": "daykeeper_tenants_list",
  "effect": "read",
  "data": []
}
```

`data` preserves the published SDK's object or resource-list shape. Failures
set MCP `isError: true` and replace `data` with `error`: bounded `kind`, `code`,
`message`, `retryable`, `fields`, `nextActions`, and optional `status`,
`correlationId` or `mutationOutcome`. Raw provider/API messages are omitted;
401/403/404 also withhold fields and next actions. `retryable` is an API hint,
never permission for an agent to repeat a write automatically.

Unknown tools and MCP protocol/input-validation failures use the official MCP
error form and may have no adapter envelope. Input diagnostics deliberately do
not echo submitted property names or values. Tool annotations describe effects;
the API, not annotations or local flags, decides authorization.

Protocol errors can echo a submitted unknown tool name or resource URI. Do not
put secrets in those identifiers. Adapter-result redaction is not a filter for
every protocol field or for the host's own logs.

No return value contains a usable new API credential. No tool exposes arbitrary
URLs, request headers, SQL, provider credentials or caller-supplied authority.
The API must continue to enforce all tenant and principal boundaries even if
an attacker uses a different SDK or MCP implementation.
