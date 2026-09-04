#!/usr/bin/env node
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import {
  createDaykeeperMcpServer,
  MCP_VERSION,
  readEnvironment,
} from "./index.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${MCP_VERSION}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Daykeeper MCP (stdio only)\nConfigure DAYKEEPER_API_URL plus exactly one DAYKEEPER_API_KEY or DAYKEEPER_ACCESS_TOKEN in the host environment.\nUse API_KEY for a scoped static headless credential; use ACCESS_TOKEN for OAuth.\nOptional DAYKEEPER_MCP_ENABLE_PLANNING=true and DAYKEEPER_MCP_ENABLE_MUTATIONS=true expose separately gated writes.\nNo HTTP listener, credential arguments, issuance, or automatic retries.\n",
    );
    return;
  }
  if (args.length !== 0) throw new Error("Unsupported arguments");
  const config = readEnvironment(process.env);
  const handle = serveStdio(() => createDaykeeperMcpServer(config), {
    legacy: "serve",
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1_048_576,
    }),
    maxSubscriptions: 0,
    onerror: () => {
      process.stderr.write(
        "Daykeeper MCP protocol request failed; details omitted.\n",
      );
    },
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 5_000);
    timer.unref();
    try {
      await handle.close();
    } catch {
      process.stderr.write(
        "Daykeeper MCP could not close cleanly; details omitted.\n",
      );
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void close();
  });
}

void main().catch(() => {
  process.stderr.write(
    "Daykeeper MCP could not start. Check configuration and supported arguments; values are not logged.\n",
  );
  process.exitCode = 1;
});
