# Compatibility

`@skyporch/daykeeper-mcp` speaks only the Daykeeper **management** contract
(`openapi/daykeeper.yaml` in `SkyPorch/daykeeper-openapi`). It does not use the
customer contract.

Contract releases are immutable tags `vMAJOR.MINOR.PATCH`. Every row records the
exact contract tag and the commit that tag points at, so a published package can
always be traced back to the contract it was built against.

| daykeeper-mcp | Management contract | Contract tag | Contract commit                            | `@skyporch/daykeeper` |
| ------------- | ------------------- | ------------ | ------------------------------------------ | --------------------- |
| 0.2.0         | 1.1.0               | `v1.1.0`     | `d2a498187f49e63e687a2d93bd7becf1193bb1e9` | 0.2.0                 |

## Notes

- Management contract 1.1.0 is the immutable release used by this package.
  It includes a breaking change: flow mutations require an
  `Idempotency-Key` header, and a replayed mutation may answer `200` alongside
  the original `201`.
- The customer contract (`openapi/customer.yaml`) is still 0.1.0 and has no
  `Idempotency-Key` requirement. It is irrelevant to this package; the header
  requirement applies to the management contract only.
- The tag and commit cells above identify the immutable contract release. A
  branch head or an unmerged PR head is never acceptable. See `RELEASING.md`.
- The package is not available from npm until the owner-approved bootstrap
  release is completed.
