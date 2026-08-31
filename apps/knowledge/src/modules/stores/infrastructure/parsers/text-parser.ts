import { Injectable } from '@nestjs/common';

import type { DocumentParser, ParsedDocument } from '../../application/ports.js';

const SUPPORTED = ['text/plain', 'text/markdown', 'text/x-markdown', 'application/json'];

/**
 * The parser that needs no other service.
 *
 * Anything richer (PDF, DOCX, images) belongs to aia-document-processing,
 * behind the same port. Until that exists, uploading one of those fails that
 * single job with `unsupported_media_type` -- it does not stop the service.
 */
@Injectable()
export class TextParser implements DocumentParser {
  supports(mimeType: string): boolean {
    return SUPPORTED.includes(mimeType.split(';')[0]?.trim() ?? '');
  }

  async parse(input: { stream: NodeJS.ReadableStream }): Promise<ParsedDocument> {
    const pieces: Buffer[] = [];
    for await (const piece of input.stream) {
      pieces.push(typeof piece === 'string' ? Buffer.from(piece) : piece);
    }
    return { markdown: Buffer.concat(pieces).toString('utf8') };
  }
}
