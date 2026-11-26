import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

// IANA special-purpose ranges. IPv4: this host, private, CGNAT, loopback,
// link-local (incl. cloud metadata 169.254.0.0/16), benchmarking, documentation,
// multicast and reserved. IPv6: only global unicast 2000::/3 is allowed, minus
// Teredo/benchmarking, documentation, 6to4, ORCHIDv2 and benchmarking subnets;
// everything else (loopback, ULA, link-local, multicast, unspecified, mapped)
// fails the allowlist.
const blocked4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(address, prefix, "ipv4");

const loopback4 = new BlockList();
loopback4.addSubnet("127.0.0.0", 8, "ipv4");

const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) blocked6.addSubnet(address, prefix, "ipv6");

/** Unmaps IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) IPv6 to dotted IPv4. */
function unmapEmbeddedIpv4(address: string): string {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const value = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
  }
  return lower;
}

/** Loopback classification after unmapping embedded IPv4. */
export function isLoopbackAddress(address: string): boolean {
  const normalized = unmapEmbeddedIpv4(address);
  const family = isIP(normalized);
  if (family === 4) return loopback4.check(normalized, "ipv4");
  if (family === 6) return normalized === "::1";
  return false;
}

/**
 * Authoritative egress classification of one resolved address. Loopback is only
 * allowed for the explicit non-production mock policy; every other special-purpose
 * range is always blocked.
 */
export function isAllowedProbeAddress(address: string, options: { allowLoopback?: boolean } = {}): boolean {
  const normalized = unmapEmbeddedIpv4(address);
  const family = isIP(normalized);
  if (family === 4) {
    if (options.allowLoopback && loopback4.check(normalized, "ipv4")) return true;
    return !blocked4.check(normalized, "ipv4");
  }
  if (family === 6) {
    if (options.allowLoopback && normalized === "::1") return true;
    return global6.check(normalized, "ipv6") && !blocked6.check(normalized, "ipv6");
  }
  return false;
}

export type PinnedAddress = { address: string; family: 4 | 6 };

/**
 * Resolves a hostname and returns one pinned address, or null when DNS fails or any
 * answer is non-public. Rejecting the whole target on any bad answer plus pinning the
 * single validated address in the socket lookup callback prevents DNS rebinding.
 */
export async function resolvePinnedAddress(
  hostname: string,
  resolve: typeof lookup = lookup,
  options: { allowLoopback?: boolean } = {},
): Promise<PinnedAddress | null> {
  let answers: LookupAddress[];
  try {
    answers = await resolve(hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (!answers.length) return null;
  for (const { address } of answers) {
    if (!isAllowedProbeAddress(address, options)) return null;
  }
  const first = unmapEmbeddedIpv4(answers[0].address);
  const family = isIP(first);
  if (family !== 4 && family !== 6) return null;
  return { address: first, family };
}
