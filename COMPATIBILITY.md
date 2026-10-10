# Compatibility

`@skyporch/daykeeper-mcp` speaks only the Daykeeper **management** contract
(`openapi/daykeeper.yaml` in `SkyPorch/daykeeper-openapi`). It does not use the
customer contract.

Contract releases are immutable tags `vMAJOR.MINOR.PATCH`. Every row records the
exact contract tag and the commit that tag points at, so a published package can
always be traced back to the contract it was built against.

| daykeeper-mcp | Management contract | Contract tag | Contract commit                            | `@skyporch/daykeeper` |
| ------------- | ------------------- | ------------ | ------------------------------------------ | --------------------- |
| 0.3.0         | 1.3.0               | `v1.3.0`     | `067465edfc6c94e63867a6dd0d9db02e12683877` | 0.3.0                 |
| 0.2.0         | 1.1.0               | `v1.1.0`     | `d2a498187f49e63e687a2d93bd7becf1193bb1e9` | 0.2.0                 |

The unreleased hosted dashboard on this branch needs `@skyporch/daykeeper`
0.6.0 (management contract 1.9.0). CI's `sdk-candidate` job packs
`SkyPorch/daykeeper-node` commit `665cd7e4eed5d17f2004dcce673fa4bd9dce82e0`
(main after PR #40 merged; SDK 0.6.0 is not released) for it. That is
a source pin, never a release claim. Before the
next MCP release: tag contract `v1.9.0`, release SDK 0.6.0, repin the
candidate to that tag's commit, and move the dependency to 0.6.0.

## Notes

- 0.3.0 consumes management contract 1.3.0 (tag `v1.3.0`) through
  `@skyporch/daykeeper` 0.3.0. Since 1.1.0 the contract widened the
  entitlement plan enum (1.2.0) and added workspace claims (1.3.0, additive),
  which back the opt-in claim tools. No existing tool changes.
- 0.2.0 consumed management contract 1.1.0, which included a breaking change: flow mutations require an
  `Idempotency-Key` header, and a replayed mutation may answer `200` alongside
  the original `201`.
- The customer contract (`openapi/customer.yaml`) is still 0.1.0 and has no
  `Idempotency-Key` requirement. It is irrelevant to this package; the header
  requirement applies to the management contract only.
- The tag and commit cells above identify the immutable contract release. A
  branch head or an unmerged PR head is never acceptable. See `RELEASING.md`.
- 0.2.0 was the owner-approved bootstrap publish and carries no provenance
  attestation. Later versions are staged through `release.yml` with provenance.
