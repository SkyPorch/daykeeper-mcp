import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepare } from "./prepare-connected-mcp.mjs";

test("preflight refuses existing output without modifying it or release files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "daykeeper-mcp-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, "sdk.tgz");
  const output = join(root, "output");
  await writeFile(sdk, "synthetic tarball");
  await mkdir(output);
  await writeFile(join(output, "sentinel"), "unchanged");
  const before = await Promise.all([
    readFile("package.json"),
    readFile("pnpm-lock.yaml"),
  ]);
  await assert.rejects(prepare(sdk, output), /must not already exist/);
  assert.equal(await readFile(join(output, "sentinel"), "utf8"), "unchanged");
  assert.deepEqual(
    await Promise.all([readFile("package.json"), readFile("pnpm-lock.yaml")]),
    before,
  );
});

test("preflight rejects a symlink SDK before invoking package tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "daykeeper-mcp-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "sdk.tgz");
  await writeFile(target, "synthetic tarball");
  await symlink(target, join(root, "alias.tgz"));
  await assert.rejects(
    prepare(join(root, "alias.tgz"), join(root, "output")),
    /regular file/,
  );
});
