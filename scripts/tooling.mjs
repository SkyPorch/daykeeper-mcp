import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

export const run = promisify(execFile);

export function toolEnvironment(directory, store) {
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CI: "true",
    NPM_CONFIG_USERCONFIG: join(directory, "empty-user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(directory, "empty-global.npmrc"),
    NPM_CONFIG_CACHE: join(directory, "npm-cache"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...(store ? { npm_config_store_dir: store } : {}),
  };
}
