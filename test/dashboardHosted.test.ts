import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardHostedHandler } from "../src/dashboardHosted.ts";

test("hosted OAuth metadata advertises RFC 9207 authorization response issuer support", async (context) => {
  const handler = createDashboardHostedHandler({
    apiUrl: new URL("https://api.example.test"),
    mcpResourceUrl: new URL("https://dashboard.example.test/mcp"),
    issuer: new URL("https://app.mydaykeeper.com"),
    allowedHostnames: ["dashboard.example.test"],
    dashboardHtml: "<!doctype html><html></html>",
  });
  context.after(async () => handler.close());

  const response = await handler.fetch(
    new Request(
      "https://dashboard.example.test/.well-known/oauth-authorization-server",
      {
        headers: { host: "dashboard.example.test" },
      },
    ),
  );
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as Record<string, unknown>;
  assert.equal(metadata.issuer, "https://app.mydaykeeper.com");
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, true);
});
