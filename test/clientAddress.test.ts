import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MCP_TRUSTED_PROXIES,
  parseTrustedProxies,
  resolveClient,
  trustedProxyMatcher,
} from "../src/clientAddress.ts";

test("trusted proxies default to private ranges plus loopback and reject malformed entries", () => {
  assert.deepEqual(parseTrustedProxies(undefined), DEFAULT_MCP_TRUSTED_PROXIES);
  assert.deepEqual(parseTrustedProxies(" , "), DEFAULT_MCP_TRUSTED_PROXIES);
  assert.deepEqual(parseTrustedProxies("172.18.0.0/16, ::1"), [
    "172.18.0.0/16",
    "::1",
  ]);
  for (const value of [
    "caddy",
    "172.18.0.0/33",
    "2001:db8::/129",
    "300.1.1.1",
    "10.0.0.0/8/8",
    "10.0.0.0/08",
    "10.0.0.0/ 8",
    "*",
    "10.0.0.1:443",
    "fe80::1%eth0",
    `10.0.0.0/8,${"1".repeat(65)}`,
  ])
    assert.throws(
      () => parseTrustedProxies(value),
      /DAYKEEPER_MCP_TRUSTED_PROXIES/,
      value,
    );
});

test("the matcher handles CIDRs, single addresses and IPv4-mapped peers", () => {
  const trusted = trustedProxyMatcher(DEFAULT_MCP_TRUSTED_PROXIES);
  for (const address of [
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.18.0.2",
    "192.168.1.1",
    "::ffff:172.18.0.2",
    "fd00::1",
  ])
    assert.equal(trusted(address), true, address);
  for (const address of [
    "203.0.113.7",
    "172.32.0.1",
    "2001:db8::1",
    "::ffff:203.0.113.7",
    undefined,
    "",
    "not-an-ip",
  ])
    assert.equal(trusted(address), false, String(address));
});

test("X-Forwarded-For is honoured only from a trusted peer and names the right-most untrusted hop", () => {
  const trusted = trustedProxyMatcher(DEFAULT_MCP_TRUSTED_PROXIES);
  assert.deepEqual(resolveClient("172.18.0.2", "203.0.113.7", trusted), {
    clientAddress: "203.0.113.7",
    forwardedFor: "203.0.113.7",
  });
  // A client cannot pick its own bucket by prepending a forged entry.
  assert.deepEqual(
    resolveClient("172.18.0.2", "198.51.100.1, 203.0.113.7, 10.0.0.9", trusted),
    {
      clientAddress: "203.0.113.7",
      forwardedFor: "198.51.100.1, 203.0.113.7, 10.0.0.9",
    },
  );
  assert.deepEqual(resolveClient("172.18.0.2", "10.0.0.9", trusted), {
    clientAddress: "10.0.0.9",
    forwardedFor: "10.0.0.9",
  });
  // Untrusted or unknown peers: the header is ignored entirely.
  assert.deepEqual(resolveClient("203.0.113.50", "198.51.100.1", trusted), {
    clientAddress: "203.0.113.50",
    forwardedFor: undefined,
  });
  assert.deepEqual(resolveClient(undefined, "198.51.100.1", trusted), {
    clientAddress: "unknown",
    forwardedFor: undefined,
  });
  // A malformed chain from a trusted peer falls back to the peer.
  assert.deepEqual(resolveClient("172.18.0.2", "evil, 1.2.3.4", trusted), {
    clientAddress: "172.18.0.2",
    forwardedFor: undefined,
  });
});
