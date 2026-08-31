import type { ChunkingStrategy } from '../value-objects/chunking-strategy.js';

export interface Chunk {
  readonly index: number;
  readonly text: string;
  /** Character offsets into the parsed document, for citation. */
  readonly start: number;
  readonly end: number;
}

/**
 * Cuts parsed markdown into chunks. Pure: no I/O, no tokenizer.
 *
 * Length is measured in characters against an approximate characters-per-token
 * ratio rather than by running a real tokenizer. A tokenizer would be exact,
 * cost a dependency per model family, and still be wrong for the next model.
 * The consequence of the approximation is a chunk slightly over or under the
 * intended size, which retrieval tolerates.
 */
const CHARS_PER_TOKEN = 4;

export function splitIntoChunks(markdown: string, strategy: ChunkingStrategy): Chunk[] {
  const size = strategy.maxTokens * CHARS_PER_TOKEN;
  const overlap = strategy.overlapTokens * CHARS_PER_TOKEN;

  const segments: Segment[] =
    strategy.kind === 'fixed'
      ? [{ text: markdown, start: 0 }]
      : strategy.kind === 'markdown-heading'
        ? splitOnHeadings(markdown)
        : splitOnParagraphs(markdown);

  const chunks: Chunk[] = [];
  for (const segment of segments) {
    for (const window of slide(segment.text, size, overlap)) {
      const text = window.text.trim();
      if (text.length === 0) continue;
      chunks.push({
        index: chunks.length,
        text,
        start: segment.start + window.start,
        end: segment.start + window.end,
      });
    }
  }

  return chunks;
}

interface Segment {
  text: string;
  start: number;
}

function splitOnHeadings(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /^#{1,6} .*$/gm;
  const starts: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) starts.push(match.index);

  if (starts.length === 0 || (starts[0] ?? 0) > 0) starts.unshift(0);

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? 0;
    const end = starts[i + 1] ?? markdown.length;
    segments.push({ text: markdown.slice(start, end), start });
  }
  return segments;
}

function splitOnParagraphs(markdown: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const part of markdown.split(/\n{2,}/)) {
    segments.push({ text: part, start: cursor });
    cursor += part.length + 2;
  }
  return segments;
}

/** Sliding window with overlap. `overlap < size` is guaranteed by the strategy. */
function slide(
  text: string,
  size: number,
  overlap: number,
): { text: string; start: number; end: number }[] {
  if (text.length <= size) return [{ text, start: 0, end: text.length }];

  const step = size - overlap;
  const windows: { text: string; start: number; end: number }[] = [];
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + size, text.length);
    windows.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
  }
  return windows;
}
