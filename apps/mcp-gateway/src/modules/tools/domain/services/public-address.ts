/**
 * Which addresses the web-fetch built-in may reach: the public internet, and
 * nothing the platform itself sits on.
 *
 * The gateway runs inside the platform's network. A fetch tool that reached
 * `http://registry:3004`, `http://169.254.169.254` or `http://[::1]` on a
 * model's say-so is server-side request forgery (OWASP LLM06 by way of
 * LLM01): whoever can put text in front of the model reads internal services.
 *
 * Pure on purpose. The adapter resolves DNS and asks this rule about EVERY
 * address it got, at connection time; deciding here, without a socket, is what
 * makes the rule testable address by address.
 */

/** `[first, prefixLength]` pairs. Anything inside one is not public. */
const BLOCKED_V4_TEXT: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, where cloud metadata services live
  ['172.16.0.0', 12], // private -- Docker's default bridge networks
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
];

/** Parsed once. A typo in the table above fails at load, not as a hole in the rule. */
const BLOCKED_V4: readonly (readonly [number, number])[] = BLOCKED_V4_TEXT.map(
  ([first, prefix]) => {
    const parsed = parseV4(first);
    if (parsed === null) throw new Error(`Not an IPv4 address in the blocked table: ${first}`);
    return [parsed, prefix] as const;
  },
);

export function isPublicAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4 !== null) return isPublicV4(v4);

  const v6 = parseV6(address);
  if (v6 !== null) return isPublicV6(v6);

  // Not an address at all. Refusing is the only safe reading.
  return false;
}

/**
 * Why a URL may not be fetched, or null when it may -- as far as can be told
 * before DNS. A hostname still has to resolve to public addresses only.
 */
export function fetchTargetRefusal(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http and https addresses can be read';
  }
  if (url.username !== '' || url.password !== '') {
    // A credential in a URL the model wrote came from somewhere it should not
    // have, and would be sent to whoever answers.
    return 'An address with a username or password in it cannot be read';
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parseV4(host) !== null || parseV6(host) !== null) {
    return isPublicAddress(host) ? null : 'That address is not on the public internet';
  }

  // A name with no dot is resolved by a local resolver by definition -- it is
  // how `registry`, `mongo` and `identity` are found inside this network.
  if (!host.includes('.')) return 'That address is not on the public internet';
  if (/(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host)) {
    return 'That address is not on the public internet';
  }
  return null;
}

function isPublicV4(address: number): boolean {
  return !BLOCKED_V4.some(([first, prefix]) => inV4Range(address, first, prefix));
}

function inV4Range(address: number, first: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (first & mask) >>> 0;
}

/**
 * IPv6 is allowed only inside global unicast (2000::/3), minus the parts of it
 * that are not a real destination. An allow-list, because the space of special
 * IPv6 ranges is large and keeps growing, and a deny-list misses the next one.
 */
function isPublicV6(groups: readonly number[]): boolean {
  const reached = embeddedV4(groups);
  if (reached !== null) return isPublicV4(reached);

  const [g0 = 0, g1 = 0] = groups;
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // IETF assignments, Teredo, ORCHID
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  return true;
}

/**
 * The IPv4 address an IPv6 one actually reaches, when it is a wrapper round
 * one -- judged as what it reaches, not as the global unicast it looks like.
 */
function embeddedV4(groups: readonly number[]): number | null {
  const v4From = (high: number, low: number): number =>
    (((groups[high] ?? 0) << 16) | (groups[low] ?? 0)) >>> 0;

  // ::ffff:a.b.c.d
  if (startsWith(groups, [0, 0, 0, 0, 0, 0xffff])) return v4From(6, 7);
  // NAT64 translates to the embedded IPv4 on the way out.
  if (startsWith(groups, [0x64, 0xff9b, 0, 0, 0, 0])) return v4From(6, 7);
  // 6to4 carries its IPv4 in the second and third groups.
  if (startsWith(groups, [0x2002])) return v4From(1, 2);
  return null;
}

function startsWith(groups: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, index) => groups[index] === value);
}

function parseV4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // Decimal only. `URL` already canonicalises `0x7f.1` and `2130706433` to
    // dotted decimal, and a resolver never answers in octal.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a trailing IPv4. */
function parseV6(text: string): number[] | null {
  if (!text.includes(':')) return null;
  // A zone index (`fe80::1%eth0`) names an interface on this host.
  if (text.includes('%')) return null;

  let body = text;
  const tail: number[] = [];

  const lastColon = body.lastIndexOf(':');
  const last = body.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === null) return null;
    tail.push(v4 >>> 16, v4 & 0xffff);
    body = body.slice(0, lastColon + 1);
    // A lone trailing colon separated the IPv4 from the groups before it; a
    // double one is compression and has to stay.
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }

  const halves = body.split('::');
  if (halves.length > 2) return null;

  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const left = groupsOf(halves[0] ?? '');
  const right = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  if (left === null || right === null) return null;

  const explicit = left.length + right.length + tail.length;
  if (halves.length === 1) {
    return explicit === 8 ? [...left, ...tail] : null;
  }
  if (explicit > 7) return null;
  return [...left, ...new Array<number>(8 - explicit).fill(0), ...right, ...tail];
}
