import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotices, writeNotices } from "./connected-mcp-notices.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "daykeeper-mcp-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "package");
  mkdirSync(pkg);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@synthetic/example",
      version: "1.2.3",
      license: "MIT",
    }),
  );
  writeFileSync(
    join(pkg, "LICENSE"),
    "MIT License\nPermission is hereby granted, free of charge.\n",
  );
  writeFileSync(join(pkg, "entry.js"), "export {}\n");
  const metafile = join(root, "meta.json");
  writeFileSync(
    metafile,
    JSON.stringify({ inputs: { "package/entry.js": {} } }),
  );
  return { root, pkg, metafile };
}

test("collects each bundled package once and writes private notices", (t) => {
  const f = fixture(t);
  const second = join(f.pkg, "second.js");
  writeFileSync(second, "export {}\n");
  writeFileSync(
    f.metafile,
    JSON.stringify({
      inputs: {
        "package/entry.js": {},
        "package/second.js": {},
      },
    }),
  );
  const outputPath = join(f.root, "THIRD_PARTY_NOTICES.txt");
  const result = writeNotices({
    metafiles: [f.metafile],
    baseCwd: f.root,
    outputPath,
  });
  assert.deepEqual(result.packages, [
    { name: "@synthetic/example", version: "1.2.3", license: "MIT" },
  ]);
  assert.equal(readFileSync(outputPath, "utf8").match(/Package:/g)?.length, 1);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
});

test("accepts an explicitly reviewed supplementary package root", (t) => {
  const f = fixture(t);
  const supplementary = join(f.root, "supplementary");
  mkdirSync(supplementary);
  writeFileSync(
    join(supplementary, "package.json"),
    JSON.stringify({
      name: "@synthetic/embedded",
      version: "2.0.0",
      license: "Apache-2.0",
    }),
  );
  writeFileSync(
    join(supplementary, "NOTICE"),
    "Apache License\nPermission is hereby granted under the Apache License.\n",
  );
  const result = createNotices({
    metafiles: [f.metafile],
    baseCwd: f.root,
    supplementaryPackageRoots: [supplementary],
  });
  assert.deepEqual(
    result.packages.map(({ name }) => name),
    ["@synthetic/example", "@synthetic/embedded"],
  );
});

test("attributes module-mode-only package.json to its enclosing package", (t) => {
  const f = fixture(t);
  const nested = join(f.pkg, "esm");
  mkdirSync(nested);
  writeFileSync(join(nested, "package.json"), '{"type":"module"}');
  writeFileSync(join(nested, "entry.js"), "export {}\n");
  writeFileSync(
    f.metafile,
    JSON.stringify({ inputs: { "package/esm/entry.js": {} } }),
  );
  const result = createNotices({ metafiles: [f.metafile], baseCwd: f.root });
  assert.deepEqual(
    result.packages.map(({ name }) => name),
    ["@synthetic/example"],
  );
});

for (const fault of [
  "missing-license",
  "outside-input",
  "symlink-input",
  "oversized-license",
])
  test(`fails closed for ${fault}`, (t) => {
    const f = fixture(t);
    if (fault === "missing-license") rmSync(join(f.pkg, "LICENSE"));
    if (fault === "outside-input")
      writeFileSync(
        f.metafile,
        JSON.stringify({ inputs: { "../outside.js": {} } }),
      );
    if (fault === "symlink-input") {
      rmSync(join(f.pkg, "entry.js"));
      symlinkSync(join(f.pkg, "LICENSE"), join(f.pkg, "entry.js"));
    }
    if (fault === "oversized-license")
      writeFileSync(
        join(f.pkg, "LICENSE"),
        "MIT License\n" + "x".repeat(512 * 1024),
      );
    assert.throws(() =>
      createNotices({ metafiles: [f.metafile], baseCwd: f.root }),
    );
    assert.equal(existsSync(join(f.root, "THIRD_PARTY_NOTICES.txt")), false);
  });
