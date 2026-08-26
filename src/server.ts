import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaykeeperClient } from "@skyporch/daykeeper";
import {
  daykeeperToolDefinitions,
  executeDaykeeperTool,
  type DaykeeperMcpOptions,
} from "./tools.js";
import { DAYKEEPER_MCP_VERSION } from "./version.js";

export function createDaykeeperMcpServer(
  client: DaykeeperClient,
  options: DaykeeperMcpOptions = {},
): McpServer {
  const server = new McpServer({
    name: "daykeeper",
    version: DAYKEEPER_MCP_VERSION,
  });

  for (const definition of daykeeperToolDefinitions(client, options)) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      (input) => executeDaykeeperTool(definition, input),
    );
  }

  return server;
}
