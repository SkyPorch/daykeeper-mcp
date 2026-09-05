# Daykeeper MCP

A local Model Context Protocol adapter for the Daykeeper management API,
published by SkyPorch as `@skyporch/daykeeper-mcp` after release approval.
This foundation is private, unpublished and read-only by default. It supports a
separately issued scoped API key for headless local use and exports a secured,
fetch-native Streamable HTTP mounting primitive. It does not deploy a hosted
endpoint, run an authorization server or issue credentials.

## Local setup

Requires Node 20 or newer and a separately issued, scoped Daykeeper credential.
Build the reviewed checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm check:cold
```

Configure your MCP host to run `node /absolute/path/to/daykeeper-mcp/dist/cli.js`
with these variables supplied through the host's protected environment or
secret manager. Never put a real token in arguments, prompts or a checked-in
configuration file.

| Variable                         | Behavior                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `DAYKEEPER_API_URL`              | Required management API base URL; HTTPS in production.                                  |
| `DAYKEEPER_API_KEY`              | Preferred static headless credential. Mutually exclusive with `DAYKEEPER_ACCESS_TOKEN`. |
| `DAYKEEPER_ACCESS_TOKEN`         | Short-lived OAuth access token. Mutually exclusive with `DAYKEEPER_API_KEY`.            |
| `DAYKEEPER_TIMEOUT_MS`           | One request budget, 1,000–60,000 ms; default 30,000.                                    |
| `DAYKEEPER_MCP_ENABLE_PLANNING`  | Exact `true` exposes two plan-creation tools; default `false`.                          |
| `DAYKEEPER_MCP_ENABLE_MUTATIONS` | Exact `true` exposes three provisioning tools; default `false`.                         |

The pinned management SDK supports HTTP only on `localhost` or `127.0.0.1` for
local development. IPv6 HTTP is not supported by that SDK version. Base paths
are preserved; URL credentials, query strings and fragments are rejected.
No HTTP listener is started. Standard output is reserved for MCP JSON-RPC;
`--help` and `--version` are standalone informational commands, not server mode.

Configure exactly one credential variable. Keep it in the MCP host's protected
environment or secret manager. `DAYKEEPER_API_KEY` is the Resend-style local
fallback for a scoped static credential; hosted OAuth remains the preferred
identity and uses `DAYKEEPER_ACCESS_TOKEN`.

The command uses the official MCP SDK 2.0.0 stdio transport for modern
`2026-07-28` clients and the SDK's legacy 2025 compatibility path. No HTTP
listener is exposed by the command. MCP hosts differ in configuration and
confirmation UX; verify a host's current instructions before installation.

## Hosted mounting primitive

`createDaykeeperMcpHttpHandler` returns a web-standard `fetch`, `close`,
`notify` and `bus` surface. A service host supplies its OAuth verifier and maps
each validated MCP identity to a distinct, short-lived, principal-scoped
Daykeeper access token:

```ts
import { createDaykeeperMcpHttpHandler } from "@skyporch/daykeeper-mcp";

const handler = createDaykeeperMcpHttpHandler({
  resourceServerUrl: new URL("https://mcp.daykeeper.example/mcp"),
  daykeeperApiUrl: new URL("https://api.daykeeper.example"),
  oauthMetadata,
  verifier: platformMcpTokenVerifier,
  allowedHostnames: ["mcp.daykeeper.example"],
  allowedOrigins: ["https://app.daykeeper.example"],
  scopesSupported: ["daykeeper.accounts:read"],
  resolvePrincipal: async (authInfo) => {
    const grant = await exchangeForDaykeeperGrant(authInfo);
    if (!grant) return null;
    return {
      principalId: grant.principalId,
      grantId: grant.grantId,
      downstreamExpiresAt: grant.expiresAt,
      daykeeper: {
        baseUrl: "https://api.daykeeper.example",
        accessToken: grant.accessToken,
        scopes: grant.scopes,
      },
    };
  },
});
```

The downstream token must be different from the incoming MCP bearer. The
verifier must return finite, short-lived expiry plus opaque
`daykeeperPrincipalId` and `daykeeperGrantId` bindings in `AuthInfo.extra`.
The resolver must return those same bindings and an explicitly scoped
downstream token that expires no later than the MCP bearer. The factory pins
that token to the configured API URL, prevents scope elevation, and rejects
concurrently active or recently observed cross-grant credential reuse. It also
enforces canonical HTTPS discovery, bearer syntax and audience, exact-origin
browser access and exact verified resource-identifier matching. Fragment-bearing
identifiers are rejected, not normalized into the configured resource; OAuth
resource identifiers must not contain fragments ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html#section-2)). It also enforces
Host validation, bounded
auth/body/stream work, and reject-fast authentication/global/per-principal
capacity. The host still owns TLS, trusted proxy configuration, OAuth consent
and token issuance, tenant membership behind the opaque grant, credential
exchange, distributed rate limits and durable audit logs. Mount the handler
only after all of those controls are configured.

## Working safely

Start with `daykeeper_capabilities` to inspect server-side execution gates.
The resource `daykeeper://adapter/capabilities` describes adapter limits,
versions and all 16 tool gates without calling the API or returning secrets.
The default eight tools only read data. See [the tool contract](TOOLS.md).

Planning persists an expiring plan; it is not a dry run or account signup.
Enable it separately, review the returned effects and exact version, and use
an explicit idempotency key for apply. No tool invents a plan, confirmation,
organization, role, scope or billing approval on behalf of the caller.

Local flags and MCP annotations are safety hints, not authorization. Every tool
uses the published `@skyporch/daykeeper@0.1.0` client against the configured API,
which must enforce current principal status, scopes, tenant ownership and
quotas. Do not share one adapter process/credential between untrusted principals.
Returned customer names, descriptions and flow text are untrusted data, not
instructions for the agent.

The adapter does not refresh tokens or retry requests automatically. It bounds
input to 512 KiB, each API response to 1 MiB, and concurrent API calls to four. One
absolute timeout includes transport and body reads. Cancellation does not undo
an operation already accepted by the API. A lost connection, timeout, HTTP 408
or server failure after a write is dispatched can return
`error.mutationOutcome: "unknown"`: inspect the operation/resource before any
explicit retry, and preserve the original apply idempotency key.

Credentials and private API diagnostics are not logged. The configured token is
redacted if echoed in returned data. Other customer content is intentionally
returned to the authorized MCP host; this is not a general-purpose secret or
personal-data scanner. Host transcripts and environment storage need their own
access and retention controls.

## Release and activation gates

`private: true`, a publication guard and no publishing workflow keep this
foundation out of npm. A separate owner-approved release must review the source
and tarball, pass checks, set the reviewed version/changelog and `private: false`,
and set `DAYKEEPER_RELEASE_APPROVED=1`. Documentation of a package name is not
proof it is available from the registry.

CI scans the complete candidate history with a checksum-pinned Gitleaks binary.
The one ignored fingerprint is an exact historical synthetic fixture credential;
new matches, including other matches in the same test file, still fail the gate.
The separately protected [release process](RELEASING.md) can only stage an
already-bootstrapped package for human review; it cannot approve publication.

The Resend-inspired destination is a hosted MCP service with explicit OAuth
consent/delegation and this scoped headless fallback. This package verifies an
already-issued bearer through an injected verifier; it does not implement the
authorization server, owner signup, API-key creation/revocation,
customer-session issuance, billing, inbox operations or workflow execution.
Those remain separate server-side work and security reviews. Never mount the
HTTP handler without authentication or map its incoming MCP bearer directly to
the management API.

Flow creation, revision and publication are available only behind two gates.
`DAYKEEPER_MCP_ENABLE_MUTATIONS=true` alone does not expose them: they also need
`DAYKEEPER_MCP_ENABLE_FLOW_WRITES=true`, and `DAYKEEPER_MCP_SCOPES` must declare
the exact scope each one needs (`daykeeper.flows:write` for create and revise,
`daykeeper.flows:publish` for publish). The adapter refuses a write locally when
its scope is not declared. Reads are never refused by that list, so the
inspection tools stay usable under a minimal write scope list; the API still
makes the real decision on every call.

Each flow write requires the caller to supply an `idempotencyKey`: one key per
intended mutation, and the same key again on any retry. The adapter never
generates a key and never retries by itself. When the outcome is uncertain the
tool answers with `outcome: "unknown"`, the key and inspection guidance instead
of an error: read the flow or version with `daykeeper_flows_get` or
`daykeeper_flow_versions_get`, then repeat the call with that same key if the
write must still happen. A server `IDEMPOTENCY_KEY_REUSED` rejection means the
key was already used for a different request; inspect first, and pick a fresh
key only when the intended request genuinely differs. Publication records
desired state; it is not proof that a runtime executes the flow.

These tools require a management SDK whose flow mutations carry an idempotency
key and report an uncertain outcome. With an older SDK installed, enabling the
flow-write gate fails at startup with a message naming the required version.

Before upgrading the pinned SDK, run `pnpm check:sdk-candidate /absolute/path/sdk.tgz`
with a trusted locally built `@skyporch/daykeeper` tarball. This creates a separate
consumer workspace, installs the candidate without install scripts, typechecks
the adapter, and requires all five real-SDK flow dispatch cases to run without
skips. It records the artifact SHA-256 and logs; it never changes the release
manifest or lockfile. Candidate code executes during tests, so do not use an
untrusted tarball. CI pins the reviewed SDK source commit for this check;
updating that pin is a separate review step, not an automatic release upgrade.
This proves injected-transport compatibility, not live flow execution.

Checks cover schema/gate behavior, published SDK request parity, redaction,
authorization denial, adversarial cancellation/transport and actual packed
stdio sessions. Loopback fixtures are not production multi-tenant certification.
No live accounts, DNS, billing or customer messages are created by the checks.

Design references: [Resend's MCP interface](https://resend.com/docs/mcp-server)
for agent onboarding and [the official MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
for transport and tool conventions. Apache-2.0; preserve [LICENSE](LICENSE) and
[NOTICE](NOTICE) when redistributing.
