import { describe, expect, it } from 'vitest';

import { splitIntoChunks } from '../src/modules/stores/domain/services/chunker.js';
import { ChunkingStrategy } from '../src/modules/stores/domain/value-objects/chunking-strategy.js';
import { InvalidStoreError } from '../src/modules/stores/domain/errors/index.js';

describe('ChunkingStrategy', () => {
  it('defaults to heading-aware chunks', () => {
    const strategy = ChunkingStrategy.default();
    expect(strategy.kind).toBe('markdown-heading');
    expect(strategy.maxTokens).toBe(512);
  });

  // An overlap at or above the window never advances: the chunker would loop
  // forever. The rule lives in the value object, not in a `while` guard.
  it('refuses an overlap that would never advance', () => {
    expect(() => ChunkingStrategy.of({ maxTokens: 128, overlapTokens: 128 })).toThrow(
      InvalidStoreError,
    );
    expect(() => ChunkingStrategy.of({ maxTokens: 128, overlapTokens: 200 })).toThrow(
      InvalidStoreError,
    );
  });

  it('bounds the window and refuses an unknown kind', () => {
    expect(() => ChunkingStrategy.of({ maxTokens: 8 })).toThrow(InvalidStoreError);
    expect(() => ChunkingStrategy.of({ maxTokens: 999_999 })).toThrow(InvalidStoreError);
    expect(() => ChunkingStrategy.of({ kind: 'semantic' })).toThrow(InvalidStoreError);
    expect(() => ChunkingStrategy.of({ overlapTokens: -1 })).toThrow(InvalidStoreError);
  });
});

describe('Chunker', () => {
  const small = ChunkingStrategy.of({ kind: 'fixed', maxTokens: 64, overlapTokens: 16 });

  it('returns a single chunk for a short document', () => {
    const chunks = splitIntoChunks('A short note.', small);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('A short note.');
  });

  it('never returns an empty chunk', () => {
    const chunks = splitIntoChunks('\n\n\n   \n\n', ChunkingStrategy.default());
    expect(chunks.every((chunk) => chunk.text.length > 0)).toBe(true);
  });

  it('terminates and covers the whole document when sliding', () => {
    const text = 'x'.repeat(64 * 4 * 5);
    const chunks = splitIntoChunks(text, small);

    expect(chunks.length).toBeGreaterThan(1);
    // Reaching the end is the property that proves the window advanced.
    expect(Math.max(...chunks.map((chunk) => chunk.end))).toBe(text.length);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
  });

  it('overlaps consecutive windows so a sentence is not cut in half', () => {
    const text = 'y'.repeat(64 * 4 * 3);
    const chunks = splitIntoChunks(text, small);
    const first = chunks[0];
    const second = chunks[1];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.start).toBeLessThan(first!.end);
  });

  it('splits on markdown headings and keeps the heading with its section', () => {
    const markdown = '# One\nalpha\n\n# Two\nbeta';
    const chunks = splitIntoChunks(markdown, ChunkingStrategy.default());

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain('# One');
    expect(chunks[0]?.text).toContain('alpha');
    expect(chunks[1]?.text).toContain('# Two');
  });

  it('keeps text before the first heading rather than dropping it', () => {
    const chunks = splitIntoChunks('preamble\n\n# One\nalpha', ChunkingStrategy.default());
    expect(chunks.some((chunk) => chunk.text.includes('preamble'))).toBe(true);
  });
});
