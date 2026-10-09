import { BlockList, isIP } from "node:net";
import { normalizeForwardedFor } from "./config.ts";

/**
 * Which socket peers may tell this host who the client is. The hosted MCP
 * listener sits behind Caddy on a private container network, so the default
 * is the private ranges plus loopback; anything else that reaches the
 * listener directly has its X-Forwarded-For ignored.
 */
export const DEFAULT_MCP_TRUSTED_PROXIES: readonly string[] = Object.freeze([
  "127.0.0.0/8",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]);

const ENTRY_PATTERN =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)(?:\/\d{1,3})?$/;

/**
 * Parse a comma-separated list of addresses or CIDRs, as strictly as the
 * Daykeeper API's trusted-proxy list: anything unparseable is rejected rather
 * than skipped, because silently dropping an entry would quietly change who
 * may set a client address. Undefined or empty means the default.
 */
export function parseTrustedProxies(
  value: string | readonly string[] | undefined,
): readonly string[] {
  if (value === undefined) return DEFAULT_MCP_TRUSTED_PROXIES;
  const entries = (typeof value === "string" ? value.split(",") : [...value])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return DEFAULT_MCP_TRUSTED_PROXIES;
  if (entries.length > 64) throw invalidProxies();
  for (const entry of entries) {
    if (entry.length > 64 || !ENTRY_PATTERN.test(entry)) throw invalidProxies();
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(address);
    if (family === 0) throw invalidProxies();
    if (prefix !== undefined) {
      const bits = Number(prefix);
      if (
        !/^(0|[1-9][0-9]{0,2})$/.test(prefix) ||
        bits > (family === 4 ? 32 : 128)
      )
        throw invalidProxies();
    }
  }
  return Object.freeze(entries);
}

export type TrustedProxyMatcher = (address: string | undefined) => boolean;

export function trustedProxyMatcher(
  entries: readonly string[],
): TrustedProxyMatcher {
  const list = new BlockList();
  for (const entry of parseTrustedProxies(entries)) {
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return (address) => {
    const normalized = normalizeAddress(address);
    if (!normalized) return false;
    return list.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4");
  };
}

/** Strip an IPv4-mapped IPv6 prefix; undefined unless a bare IP literal. */
export function normalizeAddress(
  address: string | undefined,
): string | undefined {
  if (typeof address !== "string") return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const candidate = mapped ?? address;
  return isIP(candidate) === 0 || candidate.includes("%")
    ? undefined
    : candidate;
}

export interface ResolvedClient {
  /** The address rate limits key on: the client, or the socket peer. */
  readonly clientAddress: string;
  /** The validated chain to forward downstream; only from a trusted peer. */
  readonly forwardedFor: string | undefined;
}

/**
 * Honour X-Forwarded-For only when the socket peer is a trusted proxy. The
 * client is the right-most chain entry that is not itself a trusted proxy
 * (the left-most if all are). A malformed chain is ignored entirely.
 */
export function resolveClient(
  peer: string | undefined,
  forwardedForHeader: string | null,
  isTrusted: TrustedProxyMatcher,
): ResolvedClient {
  const socketAddress = normalizeAddress(peer) ?? "unknown";
  if (!isTrusted(peer))
    return { clientAddress: socketAddress, forwardedFor: undefined };
  const chain = normalizeForwardedFor(forwardedForHeader);
  if (!chain) return { clientAddress: socketAddress, forwardedFor: undefined };
  const entries = chain.split(", ");
  let client = entries[0]!;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (!isTrusted(entries[index])) {
      client = entries[index]!;
      break;
    }
  }
  return {
    clientAddress: normalizeAddress(client) ?? socketAddress,
    forwardedFor: chain,
  };
}

function invalidProxies(): TypeError {
  return new TypeError(
    "DAYKEEPER_MCP_TRUSTED_PROXIES contains an invalid address or CIDR. Values are not logged.",
  );
}
