import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { fetchTargetRefusal, isPublicAddress } from '../../domain/services/public-address.js';

export interface FetchedPage {
  /** Where the page was finally read from, after any redirect. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** The page was longer than the client reads, and was cut. */
  readonly truncated: boolean;
}

/** The address is not one this client will reach. Worded for the model. */
export class RefusedTargetError extends Error {}

/** The page is not text this client can hand to a model. */
export class UnreadableContentError extends Error {}

type Resolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface PublicWebClientOptions {
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly userAgent: string;
  readonly isReadable: (contentType: string) => boolean;
  /** Replaced in tests, which serve pages from loopback under a public-looking name. */
  readonly resolve?: Resolver;
  readonly isAllowedAddress?: (address: string) => boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GETs a page from the public internet, and nowhere else.
 *
 * `fetch` cannot do this safely: it resolves DNS itself, so a check made
 * beforehand is answered by one lookup and the connection made by another. A
 * hostname that resolves to a public address for the check and to
 * `169.254.169.254` a second later (DNS rebinding) walks straight through.
 * Here the address is checked INSIDE the lookup the socket connects with, so
 * the address judged is the address used.
 */
export class PublicWebClient {
  private readonly resolve: Resolver;
  private readonly isAllowedAddress: (address: string) => boolean;

  constructor(private readonly options: PublicWebClientOptions) {
    this.resolve =
      options.resolve ??
      ((hostname) =>
        new Promise((resolve, reject) => {
          dnsLookup(hostname, { all: true }, (error, addresses) => {
            if (error !== null) reject(error);
            else resolve(addresses);
          });
        }));
    this.isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;
  }

  async get(url: URL, signal: AbortSignal): Promise<FetchedPage> {
    let current = url;

    for (let hop = 0; hop <= this.options.maxRedirects; hop += 1) {
      // Every hop, not only the first: a public page that redirects to an
      // internal one is the oldest way round a check made once.
      const refusal = fetchTargetRefusal(current);
      if (refusal !== null) throw new RefusedTargetError(refusal);

      const response = await this.request(current, signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (REDIRECTS.has(status) && typeof location === 'string') {
        response.destroy();
        current = new URL(location, current);
        continue;
      }

      const contentType = (response.headers['content-type'] ?? '')
        .split(';', 1)
        .join('')
        .trim()
        .toLowerCase();
      if (status >= 400) {
        // The status is the answer. An error page's markup would only spend
        // the model's context on a site's 404 template.
        response.destroy();
        return { url: current.toString(), status, contentType, body: '', truncated: false };
      }
      if (!this.options.isReadable(contentType)) {
        response.destroy();
        throw new UnreadableContentError(
          `The page is ${contentType === '' ? 'of no declared type' : contentType}, which cannot be read as text`,
        );
      }

      const { bytes, truncated } = await this.read(response);
      return {
        url: current.toString(),
        status,
        contentType,
        body: decode(bytes, response.headers['content-type'] ?? ''),
        truncated,
      };
    }

    // Not a refusal: the address was fine, the page just never settled.
    throw new UnreadableContentError(
      `The page redirected more than ${this.options.maxRedirects.toString()} times`,
    );
  }

  private request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const request = send(
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': this.options.userAgent,
            Accept:
              'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
            'Accept-Encoding': 'gzip, deflate, br',
          },
          lookup: this.guardedLookup,
          // A pooled keep-alive socket was checked when it was opened, but
          // pooling would also share it across calls made for different
          // projects. One call, one socket.
          agent: false,
          signal,
        },
        resolve,
      );
      request.on('error', reject);
      request.end();
    });
  }

  /**
   * The lookup the socket connects with. Refuses when ANY address is not
   * allowed: with several addresses the connection may try each in turn, and
   * a name answering with one public and one private address is not a
   * coincidence worth trusting.
   */
  private readonly guardedLookup: LookupFunction = (hostname, options, callback) => {
    this.resolve(hostname).then(
      (addresses) => {
        const [first] = addresses;
        if (
          first === undefined ||
          addresses.some((entry) => !this.isAllowedAddress(entry.address))
        ) {
          callback(new RefusedTargetError('That address is not on the public internet'), '', 0);
          return;
        }
        if (options.all === true) {
          callback(null, [...addresses]);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        callback(error as NodeJS.ErrnoException, '', 0);
      },
    );
  };

  private async read(response: IncomingMessage): Promise<{ bytes: Buffer; truncated: boolean }> {
    const stream = decompressed(response);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;

    // Counted AFTER decompression: a few kilobytes of gzip can inflate to
    // gigabytes, and the limit exists to protect this process's memory.
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      const room = this.options.maxBytes - size;
      if (buffer.length >= room) {
        chunks.push(buffer.subarray(0, room));
        size += room;
        truncated = buffer.length > room || !response.complete;
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }

    response.destroy();
    return { bytes: Buffer.concat(chunks, size), truncated };
  }
}

function decompressed(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;

  if (decoder === null) {
    if (encoding !== '' && encoding !== 'identity') {
      response.destroy();
      throw new UnreadableContentError(`The page is encoded as ${encoding}, which cannot be read`);
    }
    return response;
  }

  // `pipeline`, not `pipe`: a broken gzip stream has to fail the read rather
  // than leave it waiting on a decoder that will never end.
  pipeline(response, decoder, () => undefined);
  return decoder;
}

function decode(bytes: Buffer, contentTypeHeader: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentTypeHeader)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown label. UTF-8 with replacement characters is still readable.
    return new TextDecoder('utf-8').decode(bytes);
  }
}
