import assert from "node:assert/strict";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_LICENSE_BYTES = 512 * 1024;
const MAX_PACKAGES = 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LICENSE_NAME = /^(?:license|copying|notice)(?:[._-].*)?$/i;
const RECOGNIZABLE_LICENSE =
  /apache|permission is hereby granted|mit license|bsd license|mozilla public|isc license|gnu general public|copyright/i;

function privateRegular(path, label) {
  const info = lstatSync(path);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `${label} must be a regular file`,
  );
  return info;
}

function contained(base, path) {
  const value = relative(base, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
}

function packageRoot(base, input) {
  let directory = dirname(input);
  while (contained(base, directory)) {
    const manifest = join(directory, "package.json");
    try {
      privateRegular(manifest, "package metadata");
      const value = JSON.parse(readFileSync(manifest, "utf8"));
      // ESM/CJS subdirectories can contain only {"type":"module"}. They
      // define module interpretation, not a separately licensed package.
      if (typeof value.name === "string" && typeof value.version === "string")
        return directory;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (directory === base) break;
    directory = dirname(directory);
  }
  throw new Error("bundled input has no package metadata");
}

function metadata(root) {
  const path = join(root, "package.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  assert(
    typeof value.name === "string" &&
      typeof value.version === "string" &&
      typeof value.license === "string",
    "package metadata lacks name, version or license",
  );
  return value;
}

function licenseFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    if (!LICENSE_NAME.test(name)) continue;
    const path = join(root, name);
    const info = lstatSync(path);
    assert(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.size > 0 &&
        info.size <= MAX_LICENSE_BYTES,
      "license notice must be a bounded regular file",
    );
    const text = readFileSync(path, "utf8");
    assert(
      RECOGNIZABLE_LICENSE.test(text),
      "license notice text is not recognizable",
    );
    files.push({ name, text });
  }
  assert(
    files.length > 0,
    "bundled package has no recognizable license notice",
  );
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function readMetafile(path) {
  const info = privateRegular(path, "esbuild metafile");
  assert(
    info.size > 0 && info.size <= MAX_INPUT_BYTES,
    "esbuild metafile is invalid",
  );
  const value = JSON.parse(readFileSync(path, "utf8"));
  assert(
    value &&
      typeof value === "object" &&
      value.inputs &&
      typeof value.inputs === "object",
  );
  return Object.keys(value.inputs);
}

export function createNotices({
  metafiles,
  baseCwd,
  supplementaryPackageRoots = [],
}) {
  assert(
    Array.isArray(metafiles) && metafiles.length > 0,
    "at least one metafile is required",
  );
  assert(
    typeof baseCwd === "string" && isAbsolute(baseCwd),
    "base cwd must be absolute",
  );
  const base = resolve(baseCwd);
  assert(
    lstatSync(base).isDirectory() && !lstatSync(base).isSymbolicLink(),
    "base cwd must be a regular directory",
  );
  const roots = new Set();
  assert(
    Array.isArray(supplementaryPackageRoots),
    "supplementary package roots must be an array",
  );
  for (const value of supplementaryPackageRoots) {
    assert(
      typeof value === "string" && isAbsolute(value),
      "supplementary package root must be absolute",
    );
    const root = resolve(value);
    assert(
      lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
      "supplementary package root must be a regular directory",
    );
    roots.add(root);
  }
  for (const metafile of metafiles) {
    const path = resolve(metafile);
    assert(contained(base, path), "metafile must be inside base cwd");
    for (const input of readMetafile(path)) {
      const bundled = resolve(base, input);
      assert(contained(base, bundled), "bundled input must be inside base cwd");
      privateRegular(bundled, "bundled input");
      roots.add(packageRoot(base, bundled));
      assert(roots.size <= MAX_PACKAGES, "too many bundled packages");
    }
  }
  const packages = [...roots].sort().map((root) => ({
    root,
    package: metadata(root),
    notices: licenseFiles(root),
  }));
  const sections = packages.map(({ package: value, notices }) =>
    [
      `Package: ${value.name}@${value.version}`,
      `License: ${value.license}`,
      ...notices.flatMap(({ name, text }) => [
        "",
        `===== ${name} =====`,
        text.trimEnd(),
      ]),
    ].join("\n"),
  );
  const output = `${sections.join("\n\n===== PACKAGE =====\n\n")}\n`;
  assert(
    Buffer.byteLength(output) > 0 &&
      Buffer.byteLength(output) <= MAX_OUTPUT_BYTES,
    "license notices are too large",
  );
  return {
    output,
    packages: packages.map(({ package: value }) => ({
      name: value.name,
      version: value.version,
      license: value.license,
    })),
  };
}

export function writeNotices({
  metafiles,
  baseCwd,
  outputPath,
  supplementaryPackageRoots = [],
}) {
  const result = createNotices({
    metafiles,
    baseCwd,
    supplementaryPackageRoots,
  });
  const path = resolve(outputPath);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, result.output, { mode: 0o600 });
  } finally {
    closeSync(fd);
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [baseCwd, outputPath, ...metafiles] = process.argv.slice(2);
  if (!baseCwd || !outputPath || metafiles.length === 0) {
    process.stderr.write(
      "usage: connected-mcp-notices.mjs BASE_CWD OUTPUT_PATH META...\n",
    );
    process.exitCode = 2;
  } else {
    try {
      writeNotices({ metafiles, baseCwd, outputPath });
      process.stdout.write("MCP third-party notices created\n");
    } catch {
      process.stderr.write("MCP third-party notices failed\n");
      process.exitCode = 1;
    }
  }
}
