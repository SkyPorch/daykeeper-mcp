import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execute = promisify(execFile);
const TOKEN = "daykeeper_mcp_pack_synthetic_token_123456789";
const TENANT = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const PLAN = "33333333-3333-4333-8333-333333333333";
const KEY = "daykeeper-pack-apply-123456";

function data(result) {
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(TOKEN));
  assert(!serialized.includes("private-api-detail"));
  assert(result.structuredContent);
  return result.structuredContent;
}

async function command(bin, args, environment = {}) {
  let result;
  try {
    result = {
      ...(await execute(process.execPath, [bin, ...args], {
        env: { PATH: process.env.PATH, ...environment },
        timeout: 5_000,
        maxBuffer: 1_048_576,
      })),
      exitCode: 0,
    };
  } catch (error) {
    assert.equal(
      typeof error.code,
      "number",
      "Executable must exit instead of hanging",
    );
    result = {
      exitCode: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
  assert(!result.stdout.includes(TOKEN));
  assert(!result.stderr.includes(TOKEN));
  return result;
}

export async function verifyExecutable(bin) {
  const help = await command(bin, ["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /stdio only/);
  assert.match(help.stdout, /DAYKEEPER_API_KEY/);
  assert.match(help.stdout, /DAYKEEPER_ACCESS_TOKEN/);
  assert.equal(help.stderr, "");
  assert.equal((await command(bin, ["--version"])).stdout.trim(), "0.2.0");
  for (const args of [[], ["--access-token", TOKEN]]) {
    const invalid = await command(bin, args);
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /could not start/);
  }

  const requests = [];
  let redirectTargets = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/redirect-target") redirectTargets++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      key: request.headers["idempotency-key"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end(
        JSON.stringify({
          error: {
            code: "UNAUTHENTICATED",
            message: "private-api-detail",
            retryable: false,
          },
        }),
      );
    } else if (request.url === "/proxy/v1/tenants") {
      response.end(JSON.stringify({ data: [{ id: TENANT }] }));
    } else if (request.url === `/proxy/v1/tenants/${FOREIGN}`) {
      response.writeHead(404).end(
        JSON.stringify({
          error: {
            code: "NOT_FOUND",
            message: `private-api-detail ${TOKEN}`,
            retryable: true,
          },
        }),
      );
    } else if (request.url === "/proxy/v1/tenants:apply") {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["idempotency-key"], KEY);
      assert.deepEqual(JSON.parse(requests.at(-1).body), {
        planId: PLAN,
        planVersion: 1,
      });
      response.writeHead(503).end(
        JSON.stringify({
          error: {
            code: "TEMPORARILY_UNAVAILABLE",
            message: "private-api-detail",
            retryable: true,
          },
        }),
      );
    } else if (request.url === "/proxy/v1/flows") {
      response.writeHead(302, { location: "/redirect-target" }).end();
    } else {
      response.writeHead(404).end(
        JSON.stringify({
          error: {
            code: "NOT_FOUND",
            message: "private-api-detail",
            retryable: false,
          },
        }),
      );
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    for (const era of ["legacy", "modern"]) {
      for (const mutations of [false, true]) {
        let stderr = "";
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [bin],
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            DAYKEEPER_API_URL: `http://127.0.0.1:${address.port}/proxy`,
            DAYKEEPER_API_KEY: TOKEN,
            DAYKEEPER_MCP_ENABLE_MUTATIONS: String(mutations),
          },
        });
        transport.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const client = new Client(
          { name: "daykeeper-pack-verifier", version: "0.0.0" },
          {
            versionNegotiation: {
              mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" },
            },
          },
        );
        try {
          await client.connect(transport, { timeout: 5_000 });
          assert.match(client.getInstructions() ?? "", /show the exact plan/);
          assert.match(
            client.getInstructions() ?? "",
            /Never infer permission/,
          );
          const before = requests.length;
          const tools = await client.listTools();
          assert.equal(tools.tools.length, mutations ? 11 : 8);
          const resource = await client.readResource({
            uri: "daykeeper://adapter/capabilities",
          });
          assert(!JSON.stringify(resource).includes(TOKEN));
          const capabilityContent = resource.contents[0];
          assert("text" in capabilityContent);
          assert.equal(
            JSON.parse(capabilityContent.text).credentialMode,
            "api_key",
          );
          assert.equal(
            requests.length,
            before,
            "Discovery must not touch the API",
          );
          assert.deepEqual(
            data(
              await client.callTool({
                name: "daykeeper_tenants_list",
                arguments: {},
              }),
            ).data,
            [{ id: TENANT }],
          );
          const denied = data(
            await client.callTool({
              name: "daykeeper_tenants_get",
              arguments: { tenantId: FOREIGN },
            }),
          );
          assert.equal(denied.error.status, 404);
          assert.equal(denied.error.retryable, false);
          assert(!JSON.stringify(denied).includes(TENANT));
          const rejectedRedirect = data(
            await client.callTool({
              name: "daykeeper_flows_list",
              arguments: {},
            }),
          );
          assert.equal(rejectedRedirect.ok, false);
          assert.equal(redirectTargets, 0);
          const applyCall = {
            name: "daykeeper_tenants_apply",
            arguments: { planId: PLAN, planVersion: 1, idempotencyKey: KEY },
          };
          if (mutations) {
            const failure = data(await client.callTool(applyCall));
            assert.equal(failure.error.mutationOutcome, "unknown");
            assert(
              failure.error.nextActions.includes(
                "reuse_original_idempotency_key",
              ),
            );
          } else await assert.rejects(client.callTool(applyCall));
          assert.equal(
            requests.length - before,
            mutations ? 4 : 3,
            "Reads and writes must never be automatically retried",
          );
        } finally {
          await client.close();
          await transport.close();
        }
        assert.equal(
          stderr,
          "",
          "Successful MCP sessions must not emit diagnostics",
        );
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  console.log(
    "PASS executable: modern/legacy stdio, local discovery, tenant denial, no write replay, redirect refusal and clean shutdown",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await verifyExecutable(resolve("dist/cli.js"));
