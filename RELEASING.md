# Releasing `@skyporch/daykeeper-mcp`

The package is private and unpublished. A merged workflow cannot stage or
publish a package by itself; only a matching GitHub Release can enter the
protected staging job.

## Provenance status

Nothing in this repository has ever been published, so there is no attestation
to check for `@skyporch/daykeeper-mcp` yet.

The sibling packages `@skyporch/daykeeper@0.1.0` and
`@skyporch/daykeeper-react-native@0.1.0` were published **by hand**, with no
provenance attestation, even though their `package.json` declares
`publishConfig.provenance: true`. That declaration describes intent, not what
actually happened for those versions. The gap **cannot be fixed retroactively**:
an attestation is produced at publish time, and a published version's contents
are immutable. Republishing an existing version is not possible.

The fix is forward-only. The first workflow-driven release — this workflow, via
OIDC trusted publishing with `--provenance` — is what produces a real
attestation, and every release after it inherits that. Until then, treat any
0.1.0 artifact as unattested and verify it by reviewing the staged tarball.

## One-time bootstrap

1. Review and merge the complete MCP stack and its full-history scan.
2. Make the repository public only after separate visibility approval.
3. Review a release PR that updates the version and changelog, removes
   `private: true`, and preserves the release guard.
4. Publish the first approved version interactively. npm cannot stage a
   brand-new package.
5. Configure the package's npm trusted publisher for organization `SkyPorch`,
   repository `daykeeper-mcp`, workflow `release.yml`, environment
   `daykeeper-npm-production`, and **stage publish only**.
6. Set protected environment variable `DAYKEEPER_RELEASE_APPROVED` to `1`,
   require a non-author reviewer, and disallow long-lived publishing tokens.

## Release sequence

Perform these steps in exactly this order. Do not reorder or skip.

1. **Tag the contract first.** In `SkyPorch/daykeeper-openapi`, merge and tag the
   contract release as an immutable `vMAJOR.MINOR.PATCH` tag. No SDK work starts
   before that tag exists.
2. **Pin the contract.** Update `openapi/SOURCE.md` (wherever this repo vendors
   a contract) to point at that immutable **tag plus its commit SHA**. Never a
   branch head, and never an unmerged PR head. Record the same tag and SHA in
   `COMPATIBILITY.md`.
3. **Finalize the CHANGELOG** for the version being released. No `unreleased`
   marker may remain in that section.
4. **One reviewed version-bump commit**, then merge it to `main`. Run
   `pnpm check` and `gitleaks git . --no-banner --redact` on that commit before
   review completes.
5. **Create the GitHub Release from a tag on `main`.** `release.yml` refuses any
   tag that is not an ancestor of `origin/main`, and refuses a release whose
   target commitish is not `main`.
6. **`release.yml` runs and publishes with `--provenance`** via OIDC trusted
   publishing. No long-lived npm token is used or stored. The staged artifact is
   downloaded, reviewed, and approved with npm 2FA by a maintainer; stable
   versions use `latest`, prereleases use `next`.
7. **Verify provenance after publish.** Check both:
   - `https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<version>`
   - `npm view <pkg>@<version> dist.attestations`

   A release with no attestation at either endpoint has not met the bar; treat
   it as an incident rather than as a shipped release.

Reject the staged package if its digest, contents, provenance, dependency,
version, or release notes do not match the reviewed commit. Approval is the
publication action; no workflow can approve a stage.

## Dry run

`release.yml` also accepts a manual `workflow_dispatch` with `dry_run` (default
`true`). It runs the full pipeline through `npm publish --dry-run --provenance`
and never publishes or stages. Use it to rehearse a release without a tag; the
ancestor-of-main gate is skipped there because a dry run has no release tag.
