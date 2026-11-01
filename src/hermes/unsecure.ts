// Whether a connection is Unsecure (GLOSSARY.md): its traffic between this app and the server isn't encrypted.
// SSH always encrypts. A plain http:// or ws:// URL counts as encrypted only when it stays on this computer or goes
// over Tailscale, which encrypts it: loopback, a MagicDNS name (*.ts.net), a Tailscale address (100.64.0.0/10 or
// fd7a:115c:a1e0::/48), or a bare name such as `hermes` that Rust resolved into those ranges.
import type { Route } from "./pipe";

export function isUnsecure(route: Route): boolean {
  if (route.kind === "ssh") return false;
  let url: URL;
  try {
    url = new URL(route.url);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
  // The URL parser lowercases names and normalises IP literals; IPv6 ones keep their brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".ts.net") || isLoopbackOrTailscale(host)) return false;
  const bare = !host.includes(".") && !host.includes(":");
  return !(bare && route.addresses.length > 0 && route.addresses.every(isLoopbackOrTailscale));
}

/** Loopback or Tailscale, for an IP address; false for anything else, names included. */
function isLoopbackOrTailscale(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return isLoopbackOrTailscaleV4(v4);
  const g = ipv6(address);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0) return true;
  // An IPv4-mapped address (::ffff:a.b.c.d) is the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isLoopbackOrTailscaleV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  return false;
}

function isLoopbackOrTailscaleV4([a, b]: number[]): boolean {
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

function ipv4(s: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  const octets = m?.slice(1).map(Number);
  return octets?.every((o) => o <= 255) ? octets : undefined;
}

/** The eight 16-bit groups of an IPv6 address, which may use `::` and end in dotted IPv4. */
function ipv6(s: string): number[] | undefined {
  const halves = s.split("::");
  if (halves.length > 2) return;
  const parse = (part: string) => {
    if (!part) return [];
    const groups: number[] = [];
    const words = part.split(":");
    for (const [i, w] of words.entries()) {
      const v4 = i === words.length - 1 ? ipv4(w) : undefined;
      if (v4) groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      else if (/^[0-9a-f]{1,4}$/i.test(w)) groups.push(parseInt(w, 16));
      else return;
    }
    return groups;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...Array<number>(missing).fill(0), ...tail] : undefined;
}
