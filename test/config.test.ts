import assert from "node:assert/strict";
import { test } from "node:test";
import { readEnvironment, validateOptions } from "../src/config.ts";
import { defaults, TOKEN } from "./helpers.ts";

test("configuration is immutable, credential-scoped, read-only and bounded by default", () => {
  const config = validateOptions(defaults);
  assert(Object.isFrozen(config));
  assert.equal(config.enablePlanning, false);
  assert.equal(config.enableMutations, false);
  assert.equal(config.timeoutMs, 30_000);
  assert.equal(config.baseUrl, defaults.baseUrl);
  assert.deepEqual(
    readEnvironment({
      DAYKEEPER_API_URL: defaults.baseUrl,
      DAYKEEPER_ACCESS_TOKEN: TOKEN,
    }),
    config,
  );
});

for (const baseUrl of [
  "https://api.example.test/",
  "https://api.example.test/proxy/",
  "http://localhost:4100",
  "http://127.0.0.1:4100",
  "http://127.1:4100",
]) {
  test(`accepts configured HTTPS or supported actual loopback: ${baseUrl}`, () =>
    assert.doesNotThrow(() => validateOptions({ ...defaults, baseUrl })));
}

for (const baseUrl of [
  "",
  "http://api.example.test",
  "http://127.0.0.1.example.test",
  "http://10.0.2.2:4100",
  "http://[::1]:4100",
  "https://user:password@example.test",
  "https://example.test?token=secret",
  "https://example.test/#secret",
  " https://example.test",
  "https://example.test\n",
  "file:///private/secret",
  "ftp://localhost",
]) {
  test(`rejects invalid or unsupported API URL: ${JSON.stringify(baseUrl)}`, () =>
    assert.throws(() => validateOptions({ ...defaults, baseUrl }), {
      code: "INVALID_CONFIGURATION",
    }));
}

for (const accessToken of [
  "",
  "too-short",
  "test-token-with\nnewline",
  "Bearer " + TOKEN,
  "x".repeat(16_385),
  "secret;injection-test-value",
]) {
  test(`rejects invalid credential without echoing it (${accessToken.length} characters)`, () => {
    assert.throws(
      () => validateOptions({ ...defaults, accessToken }),
      (error) => {
        assert(error instanceof Error);
        if (accessToken) assert(!error.message.includes(accessToken));
        return true;
      },
    );
  });
}

test("environment flags require explicit true/false and timeout requires a bounded integer", () => {
  const environment = {
    DAYKEEPER_API_URL: defaults.baseUrl,
    DAYKEEPER_ACCESS_TOKEN: TOKEN,
  };
  for (const value of ["1", "yes", "TRUE", " true", "", TOKEN]) {
    for (const key of [
      "DAYKEEPER_MCP_ENABLE_PLANNING",
      "DAYKEEPER_MCP_ENABLE_MUTATIONS",
    ]) {
      assert.throws(() => readEnvironment({ ...environment, [key]: value }), {
        code: "INVALID_CONFIGURATION",
      });
    }
  }
  for (const value of [
    "999",
    "60001",
    "1e4",
    "1.0",
    "1000x",
    " 1000",
    "0",
    "",
  ]) {
    assert.throws(
      () => readEnvironment({ ...environment, DAYKEEPER_TIMEOUT_MS: value }),
      { code: "INVALID_CONFIGURATION" },
    );
  }
  assert.equal(
    readEnvironment({
      ...environment,
      DAYKEEPER_MCP_ENABLE_MUTATIONS: "true",
      DAYKEEPER_MCP_ENABLE_PLANNING: "false",
      DAYKEEPER_TIMEOUT_MS: "1000",
    }).timeoutMs,
    1_000,
  );
  assert.equal(
    validateOptions({ ...defaults, timeoutMs: 60_000 }).timeoutMs,
    60_000,
  );
});
