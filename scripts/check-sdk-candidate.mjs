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
import { join, resolve } from "node:path";
import { run, toolEnvironment } from "./tooling.mjs";

// A separate consumer workspace keeps the release dependency and lock intact.
// Only use a trusted, locally built SDK artifact: installing with scripts
// disabled does not make executing the candidate SDK safe for untrusted code.
assert.equal(
  process.argv.length,
  3,
  "Usage: pnpm check:sdk-candidate /absolute/path/sdk.tgz",
);
const artifact = resolve(process.argv[2]);
assert((await lstat(artifact)).isFile(), "Expected a regular SDK tarball");
const bytes = await readFile(artifact);
const directory = await mkdtemp(join(tmpdir(), "daykeeper-mcp-sdk-candidate-"));
const source = join(directory, "source");
await mkdir(source);
async function copyChecked(from, to) {
  const info = await lstat(from);
  assert(
    !info.isSymbolicLink(),
    "Candidate verification must not reuse source symlinks",
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
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "src",
  "test",
  "scripts",
])
  await copyChecked(name, join(source, name));
const originalManifest = await readFile("package.json");
const originalLock = await readFile("pnpm-lock.yaml");
const candidate = join(directory, "candidate.tgz");
await writeFile(candidate, bytes);
const env = toolEnvironment(directory, join(directory, "store"));
console.log(`Isolated packed SDK verification: ${directory}`);
async function execute(label, command, args) {
  try {
    const result = await run(command, args, {
      cwd: source,
      env,
      timeout: 180_000,
      maxBuffer: 8_388_608,
    });
    await writeFile(
      join(directory, `${label}.log`),
      result.stdout + result.stderr,
    );
    return result.stdout;
  } catch (error) {
    await writeFile(
      join(directory, `${label}.log`),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    throw new Error(
      `${label} failed; inspect ${join(directory, `${label}.log`)}`,
      { cause: error },
    );
  }
}
await execute("install", "pnpm", [
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--registry=https://registry.npmjs.org",
]);
await execute("candidate-install", "pnpm", [
  "add",
  "--offline",
  "--ignore-scripts",
  "--save-exact",
  candidate,
]);
const installed = JSON.parse(
  await readFile(
    join(source, "node_modules/@skyporch/daykeeper/package.json"),
    "utf8",
  ),
);
assert.equal(installed.name, "@skyporch/daykeeper");
await execute("typecheck", "pnpm", ["typecheck"]);
const candidateTests = (await readdir("test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);
const tap = await execute("tests", process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-reporter=tap",
  ...candidateTests,
]);
assert.match(tap, /^# fail 0$/m);
assert.match(
  tap,
  /^# skipped 0$/m,
  "Candidate must execute every flow test, not silently skip unsupported writes",
);
assert.equal(
  (tap.match(/^ok \d+ - candidate SDK:/gm) ?? []).length,
  22,
  "All five flow, five inbox, four activation, and eight operator conversation packed-SDK cases must run",
);
assert.deepEqual(await readFile("package.json"), originalManifest);
assert.deepEqual(await readFile("pnpm-lock.yaml"), originalLock);
const result = {
  sdkVersion: installed.version,
  artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  node: process.version,
  releaseManifestAndLockUnchanged: true,
  candidateDispatchTests: 22,
  skipped: 0,
  scope:
    "Real packed SDK and in-memory MCP protocol with injected HTTP fixtures; no live API or provider certification",
  directory,
};
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
