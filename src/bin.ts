#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaykeeperClient } from "@skyporch/daykeeper";
import { createDaykeeperMcpServer } from "./server.js";

try {
  const baseUrl = requiredEnvironment("DAYKEEPER_API_URL");
  const token = requiredEnvironment("DAYKEEPER_ACCESS_TOKEN");
  const server = createDaykeeperMcpServer(
    new DaykeeperClient({ baseUrl, token }),
    {
      allowMutations: environmentBoolean("DAYKEEPER_MCP_ALLOW_MUTATIONS"),
      allowUnsafeFlowMutations: environmentBoolean(
        "DAYKEEPER_MCP_ALLOW_UNSAFE_FLOW_MUTATIONS",
      ),
    },
  );
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1024 * 1024,
    }),
  );
} catch {
  process.stderr.write(
    "Daykeeper MCP could not start. Check its environment configuration.\n",
  );
  process.exitCode = 1;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function environmentBoolean(name: string): boolean {
  return process.env[name] === "true";
}
