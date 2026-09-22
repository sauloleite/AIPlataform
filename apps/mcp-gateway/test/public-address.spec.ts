import { describe, expect, it } from 'vitest';

import {
  fetchTargetRefusal,
  isPublicAddress,
} from '../src/modules/tools/domain/services/public-address.js';

/**
 * Server-side request forgery, address by address.
 *
 * The web-fetch built-in runs inside the platform's network. Every address in
 * the first table is one a model could be talked into reading if this rule
 * let it through.
 */

describe('addresses that are not the public internet', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['the rest of loopback', '127.255.0.9'],
    ['"this network"', '0.0.0.0'],
    ['a private /8', '10.1.2.3'],
    ['a Docker bridge network', '172.18.0.5'],
    ['the edge of 172.16/12', '172.31.255.255'],
    ['a home network', '192.168.1.1'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['cloud metadata', '169.254.169.254'],
    ['documentation', '203.0.113.7'],
    ['benchmarking', '198.19.0.1'],
    ['multicast', '224.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['unique local', 'fd12:3456::1'],
    ['link-local', 'fe80::1'],
    ['a link-local with a zone', 'fe80::1%eth0'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['Teredo', '2001:0:4136:e378::1'],
    ['loopback mapped into IPv6', '::ffff:127.0.0.1'],
    ['metadata mapped into IPv6, in hex', '::ffff:a9fe:a9fe'],
    ['a private address through NAT64', '64:ff9b::10.0.0.1'],
    ['a private address through 6to4', '2002:0a00:0001::1'],
    ['garbage', 'not-an-address'],
    ['an octet out of range', '256.1.1.1'],
    ['a truncated IPv4', '10.1.1'],
    ['two compressions', '1::2::3'],
  ])('refuses %s (%s)', (_case, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('addresses that are', () => {
  it.each([
    ['a public IPv4', '93.184.216.34'],
    ['just outside 172.16/12', '172.32.0.1'],
    ['just outside CGNAT', '100.128.0.1'],
    ['a public IPv6', '2606:4700:4700::1111'],
    ['a public IPv4 mapped into IPv6', '::ffff:93.184.216.34'],
    ['a public IPv4 through 6to4', '2002:5db8:d822::1'],
  ])('allows %s (%s)', (_case, address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('fetchTargetRefusal', () => {
  const refusalOf = (url: string): string | null => fetchTargetRefusal(new URL(url));

  it('allows an ordinary public page', () => {
    expect(refusalOf('https://en.wikipedia.org/wiki/Brazil')).toBeNull();
  });

  it.each([
    ['a file URL', 'file:///etc/passwd'],
    ['an FTP URL', 'ftp://example.com/'],
    ['a platform service by its container name', 'http://registry:3004/v1/assets'],
    ['localhost', 'http://localhost:3006/v1/tools'],
    ['a .localhost name', 'http://api.localhost/'],
    ['a .internal name', 'http://metadata.google.internal/'],
    ['a .local name', 'http://printer.local/'],
    ['a loopback literal', 'http://127.0.0.1:27017/'],
    ['the same loopback written as a number', 'http://2130706433/'],
    ['the same loopback written in hex', 'http://0x7f.0.0.1/'],
    ['an IPv6 loopback literal', 'http://[::1]:6379/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['credentials in the URL', 'https://user:secret@example.com/'],
  ])('refuses %s', (_case, url) => {
    expect(refusalOf(url)).not.toBeNull();
  });
});
