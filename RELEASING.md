# Releasing `@skyporch/daykeeper-mcp`

The package is private and unpublished. A merged workflow cannot stage or
publish a package by itself; only a matching GitHub Release can enter the
protected staging job.

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

## Normal release

1. Review the exact public `@skyporch/daykeeper` dependency, package version,
   changelog, MCP compatibility, source history, and packed tarball.
2. Run `pnpm check` and `gitleaks git . --no-banner --redact` on the release
   commit.
3. Tag that commit `vMAJOR.MINOR.PATCH` and publish a matching GitHub Release.
4. After the protected environment is approved, CI checks the tag and package,
   then submits it with `npm stage publish` through OIDC.
5. A maintainer downloads and reviews the staged artifact, then approves it
   with npm 2FA. Stable versions use `latest`; prereleases use `next`.

Reject the staged package if its digest, contents, provenance, dependency,
version, or release notes do not match the reviewed commit. Approval is the
publication action; no workflow can approve a stage.
