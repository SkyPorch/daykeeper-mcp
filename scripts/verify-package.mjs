import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { verifyExecutable } from "./smoke.mjs";
import { toolEnvironment } from "./tooling.mjs";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(manifest.name, "@skyporch/daykeeper-mcp");
assert.equal(manifest.license, "Apache-2.0");
assert.equal(manifest.dependencies["@skyporch/daykeeper"], "0.1.0");
assert.equal(manifest.dependencies["@modelcontextprotocol/server"], "2.0.0");
for (const group of [
  manifest.dependencies,
  manifest.optionalDependencies,
  manifest.peerDependencies,
]) {
  for (const version of Object.values(group ?? {}))
    assert.match(
      String(version),
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      "Distributable dependencies must use exact published versions",
    );
}

const directory = await mkdtemp(join(tmpdir(), "daykeeper-mcp-pack-"));
try {
  const store = execFileSync("pnpm", ["store", "path"], {
    encoding: "utf8",
  }).trim();
  const env = toolEnvironment(directory, store);
  const [pack] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
      { encoding: "utf8", env },
    ),
  );
  assert.equal(basename(pack.filename), pack.filename);
  const files = pack.files.map((file) => file.path);
  for (const required of [
    "package.json",
    "LICENSE",
    "NOTICE",
    "README.md",
    "TOOLS.md",
    "CHANGELOG.md",
    "dist/cli.js",
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
  ])
    assert(files.includes(required), `Missing package artifact: ${required}`);
  for (const file of files)
    assert(
      /^(?:dist\/|package\.json$|LICENSE$|NOTICE$|README\.md$|TOOLS\.md$|CHANGELOG\.md$)/.test(
        file,
      ),
      `Unexpected package artifact: ${file}`,
    );
  assert(!files.includes("pnpm-lock.yaml"));

  // No test, fixture or smoke material may reach the published tarball, even
  // if the files allowlist above is later widened.
  const excluded =
    /(^|\/)(?:tests?|__tests__|fixtures|smoke)(?:\/|$)|\.(?:test|spec)\./;
  for (const file of files)
    assert(
      !excluded.test(file),
      `Test or fixture path must not be published: ${file}`,
    );

  // `npm pack` must be reproducible. Pack twice into separate destinations,
  // extract both, and compare the file list plus the SHA-256 of every entry's
  // CONTENTS. The tarball itself is never hashed: gzip embeds a build
  // timestamp, so identical inputs still produce different bytes.
  const fingerprint = async (label) => {
    const destination = join(directory, `repro-${label}`);
    await mkdir(destination, { recursive: true });
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          destination,
        ],
        { encoding: "utf8", env },
      ),
    );
    execFileSync("tar", [
      "-xzf",
      join(destination, packed.filename),
      "-C",
      destination,
    ]);
    const root = join(destination, "package");
    const digests = new Map();
    const walk = async (relative) => {
      for (const entry of await readdir(join(root, relative || "."), {
        withFileTypes: true,
      })) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(next);
        else
          digests.set(
            next,
            createHash("sha256")
              .update(await readFile(join(root, next)))
              .digest("hex"),
          );
      }
    };
    await walk("");
    return { root, digests };
  };
  const first = await fingerprint("a");
  const second = await fingerprint("b");
  const differences = [];
  for (const [file, digest] of first.digests) {
    if (!second.digests.has(file)) differences.push(`only in pack A: ${file}`);
    else if (second.digests.get(file) !== digest)
      differences.push(
        `content differs: ${file}\n  A ${digest}\n  B ${second.digests.get(file)}`,
      );
  }
  for (const file of second.digests.keys())
    if (!first.digests.has(file)) differences.push(`only in pack B: ${file}`);
  assert.equal(
    differences.length,
    0,
    `npm pack is not reproducible:\n${differences.join("\n")}`,
  );

  // Every published source map must describe only files inside the published
  // dist. A `../src` or absolute source entry leaks paths that consumers cannot
  // resolve and that may disclose the build machine's layout.
  let maps = 0;
  for (const file of first.digests.keys()) {
    if (!file.endsWith(".map")) continue;
    maps += 1;
    const map = JSON.parse(await readFile(join(first.root, file), "utf8"));
    assert(Array.isArray(map.sources), `Source map has no sources: ${file}`);
    assert(
      Array.isArray(map.sourcesContent) &&
        map.sourcesContent.length === map.sources.length,
      `Source map must inline sourcesContent: ${file}`,
    );
    for (const source of map.sources) {
      assert(
        typeof source === "string" &&
          !source.startsWith("/") &&
          !/^[A-Za-z]:[\\/]/.test(source) &&
          !source.includes("://") &&
          !source.split("/").includes(".."),
        `Source map escapes the published dist: ${file} -> ${source}`,
      );
    }
  }
  assert(maps > 0, "Expected at least one published source map");
  execFileSync("tar", [
    "-xzf",
    join(directory, pack.filename),
    "-C",
    directory,
  ]);
  const extracted = join(directory, "package");
  // Verification-only: reuse the reviewed source lock without shipping it.
  await copyFile("pnpm-lock.yaml", join(extracted, "pnpm-lock.yaml"));
  execFileSync(
    "pnpm",
    ["install", "--prod", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: extracted, stdio: "pipe", timeout: 60_000, env },
  );
  for (const name of ["@skyporch/daykeeper", "@modelcontextprotocol/server"]) {
    const installed = JSON.parse(
      await readFile(
        join(extracted, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    assert.equal(installed.version, manifest.dependencies[name]);
  }
  for (const extension of ["mts", "cts"]) {
    const file = join(extracted, `consumer.${extension}`);
    await writeFile(
      file,
      `import { createDaykeeperMcpServer, type DaykeeperMcpOptions } from '@skyporch/daykeeper-mcp';\nconst oauth: DaykeeperMcpOptions = {baseUrl:'https://api.example.test', accessToken:'synthetic-type-check-token'};\nconst apiKey: DaykeeperMcpOptions = {baseUrl:'https://api.example.test', apiKey:'synthetic-type-check-api-key'};\n// @ts-expect-error Configure exactly one credential mode.\nconst ambiguous: DaykeeperMcpOptions = {baseUrl:'https://api.example.test', apiKey:'synthetic-type-check-api-key', accessToken:'synthetic-type-check-token'};\nconst server = createDaykeeperMcpServer(apiKey);\nvoid oauth; void ambiguous; void server.close();\n`,
    );
    execFileSync(
      resolve("node_modules/.bin/tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--typeRoots",
        resolve("node_modules/@types"),
        file,
      ],
      { stdio: "pipe", timeout: 30_000 },
    );
  }
  for (const [flag, code] of [
    [
      "--input-type=module",
      "const sdk = await import('@skyporch/daykeeper-mcp')",
    ],
    ["--input-type=commonjs", "const sdk = require('@skyporch/daykeeper-mcp')"],
  ]) {
    execFileSync(
      process.execPath,
      [
        flag,
        "-e",
        `${code}; if (typeof sdk.createDaykeeperMcpServer !== 'function' || sdk.SDK_VERSION !== '0.1.0') throw new Error('Invalid package export')`,
      ],
      { cwd: extracted, stdio: "pipe", timeout: 5_000 },
    );
  }
  await verifyExecutable(resolve(extracted, manifest.bin["daykeeper-mcp"]));
  console.log(
    `PASS packed MCP: ${pack.filename}; ${files.length} allowlisted files; reproducible across two packs; ${maps} in-scope source maps; exact dependencies, ESM/CJS and both declaration modes`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
