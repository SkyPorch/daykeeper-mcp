import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, toolEnvironment } from "./tooling.mjs";

const directory = await mkdtemp(join(tmpdir(), "daykeeper-mcp-cold-"));
const source = join(directory, "source");
const store = join(directory, "empty-store");
await mkdir(source);
await mkdir(store);
assert.deepEqual(await readdir(store), []);
async function copyChecked(from, to) {
  const info = await lstat(from);
  assert(
    !info.isSymbolicLink(),
    "Cold verification must not reuse dependency symlinks",
  );
  if (info.isDirectory()) {
    await mkdir(to);
    for (const name of await readdir(from))
      await copyChecked(join(from, name), join(to, name));
  } else {
    assert(info.isFile());
    await copyFile(from, to);
  }
}
for (const name of [
  ".gitignore",
  ".prettierignore",
  ".github",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "LICENSE",
  "NOTICE",
  "README.md",
  "TOOLS.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "src",
  "test",
  "scripts",
])
  await copyChecked(name, join(source, name));
const lock = await readFile("pnpm-lock.yaml");
const env = toolEnvironment(directory, store);
console.log(`Cold MCP verification from an empty store: ${directory}`);
const installed = await run(
  "pnpm",
  [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org",
  ],
  { cwd: source, env, timeout: 180_000, maxBuffer: 8_388_608 },
);
await writeFile(
  join(directory, "install.log"),
  installed.stdout + installed.stderr,
);
assert.deepEqual(await readFile(join(source, "pnpm-lock.yaml")), lock);
console.log(
  "Cold dependencies installed; checking source and the installed package...",
);
const checked = await run("pnpm", ["check"], {
  cwd: source,
  env,
  timeout: 180_000,
  maxBuffer: 8_388_608,
});
await writeFile(join(directory, "check.log"), checked.stdout + checked.stderr);
const result = {
  node: process.version,
  initiallyEmptyStore: true,
  frozenLockUnchanged: true,
  lockSha256: createHash("sha256").update(lock).digest("hex"),
  checksPassed: true,
  directory,
};
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
