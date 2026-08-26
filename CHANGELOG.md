# Changelog

## 0.1.0

- Add stdio MCP transport with narrow, structured Daykeeper tools.
- Default to read and plan tools; gate idempotent provisioning mutations behind
  an explicit operator setting.
- Keep flow mutations disabled until their API supports safe plan/apply and
  idempotency semantics.
