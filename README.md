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

| Variable                                | Behavior                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DAYKEEPER_API_URL`                     | Required management API base URL; HTTPS in production.                                                                                                 |
| `DAYKEEPER_API_KEY`                     | Preferred static headless credential. Mutually exclusive with `DAYKEEPER_ACCESS_TOKEN`.                                                                |
| `DAYKEEPER_ACCESS_TOKEN`                | Short-lived OAuth access token. Mutually exclusive with `DAYKEEPER_API_KEY`.                                                                           |
| `DAYKEEPER_TIMEOUT_MS`                  | One request budget, 1,000–60,000 ms; default 30,000.                                                                                                   |
| `DAYKEEPER_MCP_ENABLE_PLANNING`         | Exact `true` exposes two plan-creation tools; default `false`.                                                                                         |
| `DAYKEEPER_MCP_ENABLE_MUTATIONS`        | Exact `true` exposes three provisioning tools; default `false`.                                                                                        |
| `DAYKEEPER_MCP_ENABLE_INBOX_TOOLS`      | Exact `true` enables SDK-gated inbox/provisioning reads; website planning also needs the planning flag. Default `false`.                               |
| `DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS` | Exact `true` exposes activation inspection with a compatible SDK. Create/revoke also need mutations and declared account-write scope. Default `false`. |
| `DAYKEEPER_MCP_ENABLE_OPERATOR_TOOLS`   | Exact `true` exposes tenant-scoped operator conversation reads with a compatible SDK. Default `false`.                                                 |
| `DAYKEEPER_MCP_ENABLE_OPERATOR_WRITES`  | Exact `true` separately approves the outgoing reply tool; it also needs mutations and the declared conversation-write scope. Default `false`.          |

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
versions and all 19 tool gates without calling the API or returning secrets.
The default eight tools only read data. See [the tool contract](TOOLS.md).

Planning persists an expiring plan; it is not a dry run or account signup.
Enable it separately, review the returned effects and exact version, and use
an explicit idempotency key for apply. No tool invents a plan, confirmation,
organization, role, scope or billing approval on behalf of the caller.

Local flags and MCP annotations are safety hints, not authorization. Every tool
uses the pinned `@skyporch/daykeeper@0.1.0` client against the configured API
(new inbox/flow surfaces require a separately reviewed SDK candidate upgrade),
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
customer-session issuance, billing, traffic activation or workflow execution.
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
the adapter, and runs the full MCP test suite with zero skips, explicitly requiring
all five flow, five inbox and four activation real-SDK cases. It records the artifact
SHA-256 and logs; it never changes the release
manifest or lockfile. Candidate code executes during tests, so do not use an
untrusted tarball. CI pins the reviewed SDK source commit for this check;
updating that pin is a separate review step, not an automatic release upgrade.
This proves injected-transport compatibility, not live flow execution.

## Programmatic inbox onboarding

The unpublished `@skyporch/daykeeper@0.2.0` candidate adds generic inbox, website inbox and
tenant provisioning and activation methods. CI pins source `c9d67753465af85f46a0f473ffdc77bd6bd80320`
and packs it separately; the release dependency/lockfile remain at 0.1.0.
With the older SDK, `DAYKEEPER_MCP_ENABLE_INBOX_TOOLS=true` refuses startup rather
than exposing broken tools. Local capability discovery performs no API calls.

Activation has its own independent, default-off gate. With a compatible SDK,
`DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS=true` exposes retained receipt inspection.
Create/revoke additionally need `DAYKEEPER_MCP_ENABLE_MUTATIONS=true` and explicit
`DAYKEEPER_MCP_SCOPES` containing `daykeeper.accounts:write`. The server requires
a current machine-owner credential; OAuth and delegated credentials cannot
activate an inbox. Declaring a scope locally grants no server permissions.

After preparation succeeds, call `daykeeper_inbox_activations_create` with
`{tenantId, idempotencyKey}`. Retain that key as the activation intent. Read with
`daykeeper_inbox_activations_get` or revoke with
`daykeeper_inbox_activations_revoke`, using `{tenantId, intent}`. No customer DNS,
website installation or human sign-in is required. A retained `active` receipt is
not proof of current readiness: inspect `daykeeper_inboxes_get` separately.
After an uncertain write, inspect the same intent; the adapter never retries
automatically or generates a replacement intent. Revocation is terminal in this
candidate; reactivation/rebinding remains a separate unfinished recovery protocol.

After independent signup through the onboarding SDK, supply the scoped credential
through the MCP host's protected environment. The MCP adapter does not generate
or return owner private keys or issue signup credentials into transcripts.

With the reviewed newer SDK and inbox/planning flags enabled, use
`daykeeper_website_inboxes_plan` with an explicit tenant spec and `website`
settings, or use `daykeeper_tenants_plan` with `inbox: {"type":"api"}` for an
API-only inbox. Inspect its effects, then use existing
`daykeeper_tenants_apply` with the exact plan/version and one caller-supplied
idempotency key; that step still needs the independent mutation gate and server
authorization. Use `daykeeper_inboxes_get` for either channel kind; use
`daykeeper_website_channels_get` for website-only metadata.
`daykeeper_tenant_provisioning_get` recovers the current operation by tenant ID,
and `daykeeper_website_channels_get` inspects preparation and `trafficEnabled`.
These reads do not poll, retry, create resources or activate traffic. A prepared
inbox is not evidence of a successful customer exchange. API-only planning needs
no website, DNS or administrator metadata; traffic activation remains a separate
opt-in platform capability, exposed by the activation tools above.

Checks cover schema/gate behavior, published SDK request parity, redaction,
authorization denial, adversarial cancellation/transport and actual packed
stdio sessions. Loopback fixtures are not production multi-tenant certification.
No live accounts, DNS, billing or customer messages are created by the checks.

### Connected-stack test artifact

From a reviewed checkout with locked dependencies installed, build a test-only
runtime for the platform's isolated connected journey:

```sh
node scripts/prepare-connected-mcp.mjs \
  /absolute/skyporch-daykeeper-0.2.0.tgz \
  /absolute/fresh-mcp-runtime
```

Only use a trusted, reviewed SDK tarball. The helper builds and packs MCP with
that SDK in a temporary workspace, installs the resulting tarball in a separate
consumer, and bundles the installed executable and protocol client. It leaves
the consumer's dependencies pinned to the frozen source versions (apart from
adding MCP itself). Optional platform binaries may materialize differently on
cold runners, but must match the exact versions in that snapshot. Cold builds may fetch registry metadata for the
local SDK override; the connected runtime itself requires no registry access.
It leaves
the release manifest and lockfile unchanged, removes its temporary workspace,
and emits `cli.mjs`, `client.mjs`, `manifest.json`, and
`THIRD_PARTY_NOTICES.txt`. A failed output is retained for inspection; use a fresh
output path on the next attempt. Hashes identify the inputs and payloads, not a
registry publication or an independent signature.

The builder verifies real stdio initialization and tool discovery, without an API
server. The platform's separate MCP-enabled journey then uses this runtime
against a disposable real provider: SDK signup, MCP plan/apply/retry/activation,
SDK customer exchanges, and cross-workspace read/revoke refusal. Run both that
journey and its SDK-only baseline before updating a platform fixture. Neither
the builder nor a successful disposable journey authorizes production changes.

Design references: [Resend's MCP interface](https://resend.com/docs/mcp-server)
for agent onboarding and [the official MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
for transport and tool conventions. Apache-2.0; preserve [LICENSE](LICENSE) and
[NOTICE](NOTICE) when redistributing.
