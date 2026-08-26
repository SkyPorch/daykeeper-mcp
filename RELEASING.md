# Releasing `@skyporch/daykeeper-mcp`

Before the first release, choose and commit a license, scan the complete
history, make the repository public, bootstrap `@skyporch/daykeeper` first, and
then bootstrap this package interactively. npm cannot stage a brand-new package.

Configure npm trusted publishing for `SkyPorch/daykeeper-mcp`, workflow
`release.yml`, and environment `daykeeper-npm-production`. Matching GitHub
releases submit through OIDC and `npm stage publish`; a maintainer downloads and
reviews the staged tarball and approves it with npm 2FA. Stable releases use
`latest`, prereleases use `next`, and no long-lived npm token is stored in
GitHub.
