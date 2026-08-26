# SDK dependency bootstrap

`@skyporch/daykeeper@0.1.0` does not yet exist on npm. This source is locally
verified against sibling `SkyPorch/daykeeper-node` commit `46ee05c`, but a
clean registry install intentionally waits for the reviewed SDK bootstrap.

After that release, run `pnpm install`, commit the lockfile, require the full
package CI job, and repeat package-content and secret-history review. Do not
replace the dependency with copied SDK source, a workspace range, an unreviewed
Git URL, or a registry token.
