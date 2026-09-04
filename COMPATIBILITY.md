# Compatibility

`@skyporch/daykeeper-mcp` speaks only the Daykeeper **management** contract
(`openapi/daykeeper.yaml` in `SkyPorch/daykeeper-openapi`). It does not use the
customer contract.

Contract releases are immutable tags `vMAJOR.MINOR.PATCH`. Every row records the
exact contract tag and the commit that tag points at, so a published package can
always be traced back to the contract it was built against.

| daykeeper-mcp      | Management contract | Contract tag                       | Contract commit                         | `@skyporch/daykeeper` |
| ------------------ | ------------------- | ---------------------------------- | --------------------------------------- | --------------------- |
| 0.1.0 (unreleased) | 0.2.0               | `v0.2.0` (pending; not yet tagged) | pending — record the SHA before release | 0.1.0                 |

## Notes

- Management contract 0.2.0 is a breaking change: flow mutations require an
  `Idempotency-Key` header, and a replayed mutation may answer `200` alongside
  the original `201`.
- The customer contract (`openapi/customer.yaml`) is still 0.1.0 and has no
  `Idempotency-Key` requirement. It is irrelevant to this package; the header
  requirement applies to the management contract only.
- The tag and commit cells above MUST be filled with the immutable tag and its
  SHA before this package is released. A branch head or an unmerged PR head is
  never acceptable. See `RELEASING.md`.
- This package is `private: true` and has never been published to npm.
