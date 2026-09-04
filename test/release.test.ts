import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

test("private foundation cannot be published by setting an approval environment flag", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.private, true);
  for (const approval of [undefined, "1"]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, ["scripts/verify-release.mjs"], {
        cwd: new URL("../", import.meta.url),
        env: {
          PATH: process.env.PATH,
          ...(approval ? { DAYKEEPER_RELEASE_APPROVED: approval } : {}),
        },
        timeout: 2_000,
      }),
      (error) => {
        assert(error instanceof Error && "code" in error && "stderr" in error);
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /foundation is not publishable/);
        return true;
      },
    );
  }
});
