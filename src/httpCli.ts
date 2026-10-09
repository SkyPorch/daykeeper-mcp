#!/usr/bin/env node
import { MCP_VERSION } from "./config.ts";
import { startDaykeeperMcpHttpServer } from "./hosted.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${MCP_VERSION}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Daykeeper MCP hosted HTTP server (Daykeeper Dashboard for ChatGPT)\nRequired: DAYKEEPER_MCP_RESOURCE_URL, DAYKEEPER_INTERNAL_API_URL, DAYKEEPER_OAUTH_ISSUER, DAYKEEPER_OAUTH_INTROSPECTION_SECRET, DAYKEEPER_MCP_WIDGET_DOMAIN.\nOptional: DAYKEEPER_MCP_HTTP_PORT (4108), DAYKEEPER_MCP_HTTP_HOST (0.0.0.0), DAYKEEPER_MCP_ALLOWED_HOSTNAMES (resource host), DAYKEEPER_MCP_ALLOWED_ORIGINS (https://chatgpt.com), DAYKEEPER_MCP_INTERNAL_HOSTNAMES (daykeeper-api).\nServes /healthz, the protected-resource metadata and the MCP endpoint. Bearers are verified by introspection and passed through to the internal API.\n",
    );
    return;
  }
  if (args.length !== 0) throw new Error("Unsupported arguments");
  const handle = await startDaykeeperMcpHttpServer(process.env, {
    onerror: (message) => process.stderr.write(`${message}\n`),
  });
  process.stderr.write(`Daykeeper MCP listening on ${handle.address}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    try {
      await handle.close();
    } catch {
      process.stderr.write("Daykeeper MCP could not close cleanly.\n");
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}

void main().catch(() => {
  process.stderr.write(
    "Daykeeper MCP HTTP could not start. Check configuration; values are not logged.\n",
  );
  process.exitCode = 1;
});
