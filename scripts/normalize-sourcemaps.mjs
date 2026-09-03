/**
 * Rewrites every published source map so its `sources` stay inside `dist`.
 *
 * tsup emits `../src/index.ts`, which points outside the published tarball:
 * consumers cannot resolve it, and the path discloses the build layout. The
 * original text is already inlined as `sourcesContent`, so the path only has
 * to be a stable label. Strip the leading `../` segments to land on
 * `src/index.ts`, which resolves inside `dist` and reads the same in a
 * debugger. Fails loudly if any source lacks inlined content, since the
 * rewritten path would then resolve to nothing.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = "dist";
let rewritten = 0;
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".map")) continue;
  const file = join(dist, entry.name);
  const map = JSON.parse(await readFile(file, "utf8"));
  assert(Array.isArray(map.sources), `Source map has no sources: ${file}`);
  // A pure re-export barrel legitimately maps to nothing.
  if (map.sources.length === 0) continue;
  assert(
    Array.isArray(map.sourcesContent) &&
      map.sourcesContent.length === map.sources.length &&
      map.sourcesContent.every((content) => typeof content === "string"),
    `Source map must inline sourcesContent: ${file}`,
  );
  delete map.sourceRoot;
  map.sources = map.sources.map((source) =>
    String(source)
      .replace(/^(?:\.\.\/)+/, "")
      .replace(/^\.\//, ""),
  );
  for (const source of map.sources)
    assert(
      !source.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(source) &&
        !source.includes("://") &&
        !source.split("/").includes(".."),
      `Source map still escapes dist after normalization: ${file} -> ${source}`,
    );
  await writeFile(file, JSON.stringify(map));
  rewritten += 1;
}
console.log(
  `PASS normalized ${rewritten} source maps to dist-relative sources`,
);
