import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { toolEnvironment } from "./tooling.mjs";
import { createNotices } from "./connected-mcp-notices.mjs";

const execute = promisify(execFile);
const run = (command, args, options = {}) =>
  execute(command, args, {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
const REQUIRED_SDK = "0.2.0";
const SOURCE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "README.md",
  "CHANGELOG.md",
  "TOOLS.md",
  "NOTICE",
  "LICENSE",
  "src",
  "scripts",
];

async function copyChecked(from, to) {
  const info = await lstat(from);
  assert(!info.isSymbolicLink(), `Refusing source symlink: ${from}`);
  if (info.isDirectory()) {
    await mkdir(to);
    for (const name of await readdir(from))
      await copyChecked(join(from, name), join(to, name));
  } else {
    assert(info.isFile(), `Expected regular source file: ${from}`);
    await cp(from, to);
  }
}

async function installedPackages(directory, env) {
  const rows = JSON.parse(
    (
      await run("pnpm", ["list", "--depth", "Infinity", "--json"], {
        cwd: directory,
        env,
      })
    ).stdout,
  );
  const packages = new Set();
  const overrides = {};
  const seen = new Set();
  async function visit(node) {
    const parent = JSON.parse(
      await readFile(join(node.path, "package.json"), "utf8"),
    );
    for (const kind of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ])
      for (const child of Object.values(node[kind] ?? {})) {
        let value;
        try {
          value = JSON.parse(
            await readFile(join(child.path, "package.json"), "utf8"),
          );
        } catch (error) {
          // Optional packages can be absent from successful installations.
          // A package present in only one still fails the set comparison.
          if (
            error?.code === "ENOENT" &&
            parent.optionalDependencies?.[child.from]
          )
            continue;
          throw error;
        }
        if (value.name !== "@skyporch/daykeeper-mcp")
          packages.add(`${value.name}@${value.version}`);
        if (value.name !== "@skyporch/daykeeper") {
          const selector = `${parent.name}@${parent.version}>${value.name}`;
          if (overrides[selector] !== undefined)
            assert.equal(
              overrides[selector],
              value.version,
              "Ambiguous dependency pin",
            );
          overrides[selector] = value.version;
        }
        if (seen.has(child.path)) continue;
        seen.add(child.path);
        await visit(child);
      }
  }
  for (const row of rows) await visit(row);
  return { versions: [...packages].sort(), overrides };
}

async function prepare(sdkTarball, outputDirectory) {
  const sdk = resolve(sdkTarball);
  const output = resolve(outputDirectory);
  assert((await lstat(sdk)).isFile(), "SDK tarball must be a regular file");
  try {
    await lstat(output);
    throw new Error("output artifact must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const work = mkdtempSync(join(tmpdir(), "daykeeper-mcp-connected-"));
  const releaseManifest = await readFile("package.json");
  const releaseLock = await readFile("pnpm-lock.yaml");
  let stage = "copy-source";
  try {
    const sdkLocal = join(work, "sdk.tgz");
    await cp(sdk, sdkLocal);
    const source = join(work, "source");
    await mkdir(source, { mode: 0o700 });
    for (const name of SOURCE_FILES)
      await copyChecked(name, join(source, name));
    await writeFile(join(source, "empty-user.npmrc"), "", { mode: 0o600 });
    await writeFile(join(source, "empty-global.npmrc"), "", { mode: 0o600 });
    const env = toolEnvironment(work, join(work, "store"));
    stage = "install-source";
    await run(
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--package-import-method=copy",
      ],
      {
        cwd: source,
        env,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    stage = "install-sdk";
    await run(
      "pnpm",
      [
        "add",
        "--offline",
        "--ignore-scripts",
        "--package-import-method=copy",
        "--save-exact",
        sdkLocal,
      ],
      {
        cwd: source,
        env,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const installed = JSON.parse(
      await readFile(
        join(source, "node_modules/@skyporch/daykeeper/package.json"),
        "utf8",
      ),
    );
    assert.equal(installed.version, REQUIRED_SDK);
    stage = "build-mcp";
    await run("pnpm", ["build"], {
      cwd: source,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });

    const packedManifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    packedManifest.dependencies["@skyporch/daykeeper"] = REQUIRED_SDK;
    await writeFile(
      join(source, "package.json"),
      `${JSON.stringify(packedManifest, null, 2)}\n`,
    );
    const packedDirectory = join(work, "packed");
    await mkdir(packedDirectory);
    stage = "pack-mcp";
    const packResult = JSON.parse(
      (
        await run(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            packedDirectory,
          ],
          {
            cwd: source,
            env,
            maxBuffer: 8 * 1024 * 1024,
          },
        )
      ).stdout,
    )[0];
    const mcpTarball = join(packedDirectory, packResult.filename);
    assert(
      (await lstat(mcpTarball)).isFile(),
      "MCP package tarball was not created",
    );
    assert.deepEqual(await readFile("package.json"), releaseManifest);
    assert.deepEqual(await readFile("pnpm-lock.yaml"), releaseLock);
    const lockedPackages = await installedPackages(source, env);
    const consumer = join(work, "consumer");
    await mkdir(consumer, { mode: 0o700 });
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ ...packedManifest, name: "daykeeper-mcp-connected-consumer", private: true, pnpm: { overrides: { ...packedManifest.pnpm?.overrides, ...lockedPackages.overrides, "@skyporch/daykeeper": `file:${sdkLocal}` } } }, null, 2)}\n`,
    );
    await cp(join(source, "pnpm-lock.yaml"), join(consumer, "pnpm-lock.yaml"));
    stage = "install-consumer";
    await run(
      "pnpm",
      [
        "add",
        "--prefer-offline",
        "--ignore-scripts",
        "--package-import-method=copy",
        "--save-exact",
        mcpTarball,
      ],
      {
        cwd: consumer,
        env,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    // A cold runner may need registry metadata for the new local override.
    // It must not silently select a different dependency graph from the
    // frozen source installation. Only the packed MCP package is added.
    stage = "verify-consumer-graph";
    const consumerVersions = (await installedPackages(consumer, env)).versions;
    if (
      JSON.stringify(consumerVersions) !==
      JSON.stringify(lockedPackages.versions)
    ) {
      const safeNames = (values) =>
        values
          .filter((value) => /^[A-Za-z0-9@/_.+\-]{1,180}$/.test(value))
          .slice(0, 32);
      process.stderr.write(
        `${JSON.stringify({
          stage,
          sourceOnly: safeNames(
            lockedPackages.versions.filter(
              (value) => !consumerVersions.includes(value),
            ),
          ),
          consumerOnly: safeNames(
            consumerVersions.filter(
              (value) => !lockedPackages.versions.includes(value),
            ),
          ),
        })}\n`,
      );
    }
    assert.deepEqual(consumerVersions, lockedPackages.versions);

    await mkdir(output, { mode: 0o700 });
    const clientEntry = join(source, "client-entry.mjs");
    const require = createRequire(join(consumer, "package.json"));
    const clientModule = require.resolve("@modelcontextprotocol/client");
    const stdioModule = require.resolve("@modelcontextprotocol/client/stdio");
    const installedPackageDirectory = join(
      consumer,
      "node_modules/@skyporch/daykeeper-mcp",
    );
    const installedPackage = JSON.parse(
      await readFile(join(installedPackageDirectory, "package.json"), "utf8"),
    );
    const installedCli = join(
      installedPackageDirectory,
      installedPackage.bin["daykeeper-mcp"],
    );
    await writeFile(
      clientEntry,
      `export { Client } from ${JSON.stringify(clientModule)};\nexport { StdioClientTransport } from ${JSON.stringify(stdioModule)};\n`,
      { mode: 0o600 },
    );
    const esbuild = join(source, "node_modules/.bin/esbuild");
    stage = "bundle-cli";
    await run(
      esbuild,
      [
        installedCli,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=bundle",
        `--metafile=${join(work, "cli-meta.json")}`,
        `--outfile=${join(output, "cli.mjs")}`,
      ],
      { cwd: work, env, maxBuffer: 8 * 1024 * 1024 },
    );
    stage = "bundle-client";
    await run(
      esbuild,
      [
        clientEntry,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=bundle",
        "--external:node:*",
        '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
        `--metafile=${join(work, "client-meta.json")}`,
        `--outfile=${join(output, "client.mjs")}`,
      ],
      { cwd: work, env, maxBuffer: 8 * 1024 * 1024 },
    );
    stage = "load-client";
    const { Client, StdioClientTransport } = await import(
      pathToFileURL(join(output, "client.mjs")).href
    );
    const hashFile = async (path) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    stage = "notices";
    const notices = createNotices({
      metafiles: [join(work, "cli-meta.json"), join(work, "client-meta.json")],
      baseCwd: work,
      supplementaryPackageRoots: [
        await realpath(join(consumer, "node_modules/@skyporch/daykeeper")),
      ],
    });
    await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), notices.output, {
      mode: 0o600,
    });
    stage = "manifest";
    await writeFile(
      join(output, "manifest.json"),
      `${JSON.stringify(
        {
          artifactVersion: 1,
          sdkVersion: installed.version,
          sdkSha256: createHash("sha256")
            .update(await readFile(sdkLocal))
            .digest("hex"),
          // Compression implementations may produce different gzip bytes for
          // the identical tar stream; retain both identities for auditability.
          sdkTarSha256: createHash("sha256")
            .update(
              gunzipSync(await readFile(sdkLocal), {
                maxOutputLength: 64 * 1024 * 1024,
              }),
            )
            .digest("hex"),
          sourceCommit: (
            await run("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })
          ).stdout.trim(),
          entrypoint: "cli.mjs",
          client: "client.mjs",
          transport: "stdio",
          source: "trusted local SDK tarball and packed MCP tarball",
          mcpPackageSha256: createHash("sha256")
            .update(await readFile(mcpTarball))
            .digest("hex"),
          files: {
            "cli.mjs": await hashFile(join(output, "cli.mjs")),
            "client.mjs": await hashFile(join(output, "client.mjs")),
            "THIRD_PARTY_NOTICES.txt": await hashFile(
              join(output, "THIRD_PARTY_NOTICES.txt"),
            ),
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    stage = "stdio";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(output, "cli.mjs")],
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        DAYKEEPER_API_URL: "http://127.0.0.1:9",
        DAYKEEPER_API_KEY: "daykeeper_connected_synthetic_owner_key",
      },
    });
    const client = new Client(
      { name: "daykeeper-connected-preparer", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(transport, { timeout: 5_000 });
      const tools = await client.listTools();
      assert(
        tools.tools.length >= 8,
        "packed MCP server did not list baseline tools",
      );
      assert(
        !tools.tools.some(
          (tool) => tool.name === "daykeeper_inbox_activations_create",
        ),
      );
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
    return {
      output,
      sdkVersion: installed.version,
      entrypoint: join(output, "cli.mjs"),
    };
  } catch (error) {
    const code =
      typeof error?.code === "number"
        ? String(error.code)
        : typeof error?.code === "string" &&
            /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
          ? error.code
          : "ERROR";
    // Report only a fixed stage and bounded error code, never child output,
    // caller paths, configuration values, or package-manager diagnostics.
    throw new Error(
      `MCP connected artifact preparation failed at ${stage} (${code})`,
      { cause: error },
    );
  } finally {
    try {
      assert.deepEqual(await readFile("package.json"), releaseManifest);
      assert.deepEqual(await readFile("pnpm-lock.yaml"), releaseLock);
    } finally {
      // Only this invocation's fresh private workspace is removed. A failed
      // output artifact is retained for inspection and cannot be reused.
      await rm(work, { recursive: true, force: true });
    }
  }
}

const [sdkTarball, outputDirectory] = process.argv.slice(2);
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!sdkTarball || !outputDirectory || process.argv.length !== 4) {
    process.stderr.write(
      "usage: prepare-connected-mcp.mjs SDK_TARBALL OUTPUT_DIRECTORY\n",
    );
    process.exitCode = 2;
  } else {
    prepare(sdkTarball, outputDirectory)
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        const message =
          /^MCP connected artifact preparation failed at [a-z-]+ \([A-Z0-9_]+\)$/.test(
            error?.message ?? "",
          )
            ? error.message
            : "MCP connected artifact preparation failed";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      });
  }
}

export { prepare };
