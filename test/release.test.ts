import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

test("release guard requires explicit owner approval", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.private, false);
  await assert.rejects(
    promisify(execFile)(process.execPath, ["scripts/verify-release.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH },
      timeout: 2_000,
    }),
    (error) => {
      assert(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 1);
      assert.match(String(error.stderr), /owner-approved release/);
      return true;
    },
  );
});

test("release guard checks versions for tags, not manual dry runs", async () => {
  const run = (env: NodeJS.ProcessEnv) =>
    promisify(execFile)(process.execPath, ["scripts/verify-release.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH, DAYKEEPER_RELEASE_APPROVED: "1", ...env },
      timeout: 2_000,
    });

  await assert.doesNotReject(
    run({ GITHUB_REF_NAME: "main", GITHUB_REF_TYPE: "branch" }),
  );
  await assert.rejects(
    run({ GITHUB_REF_NAME: "v0.1.0", GITHUB_REF_TYPE: "tag" }),
    /Git tag must match package version/,
  );
});
