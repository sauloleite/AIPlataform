import { describe, expect, it } from 'vitest';

import { fuse, RRF_K } from '../src/modules/stores/domain/services/fusion.js';

const chunk = (documentId: string, chunkIndex = 0): { documentId: string; chunkIndex: number } => ({
  documentId,
  chunkIndex,
});
const scored = (
  documentId: string,
  score: number,
): { documentId: string; chunkIndex: number; score: number } => ({
  ...chunk(documentId),
  score,
});

const ids = (results: { documentId: string }[]): string[] =>
  results.map((result) => result.documentId);

describe('fuse', () => {
  it('puts a chunk both rankings found above one either ranking loves alone', () => {
    // The whole point. `b` is second in both; `a` is first in one and absent
    // from the other. Agreement beats enthusiasm.
    const result = fuse({
      vector: [scored('a', 0.9), scored('b', 0.8)],
      text: [chunk('c'), chunk('b')],
      limit: 3,
    });

    expect(ids(result)[0]).toBe('b');
  });

  it('surfaces a chunk only the lexical ranking found', () => {
    // The failure that motivated hybrid search: an exact token the vector
    // ranking buries below the cut still has to reach the answer.
    const result = fuse({
      vector: [scored('a', 0.55), scored('b', 0.54), scored('c', 0.53)],
      text: [chunk('z')],
      limit: 4,
    });

    expect(ids(result)).toContain('z');
    expect(result.find((hit) => hit.documentId === 'z')?.retrieval).toBe('text');
  });

  it('reports which rankings found each chunk', () => {
    const result = fuse({ vector: [scored('a', 0.9)], text: [chunk('a'), chunk('b')], limit: 5 });

    expect(result.find((hit) => hit.documentId === 'a')?.retrieval).toBe('both');
    expect(result.find((hit) => hit.documentId === 'b')?.retrieval).toBe('text');
  });

  it('keeps the cosine only for what the vector ranking reached', () => {
    const result = fuse({ vector: [scored('a', 0.87)], text: [chunk('b')], limit: 5 });

    expect(result.find((hit) => hit.documentId === 'a')?.vectorScore).toBe(0.87);
    expect(result.find((hit) => hit.documentId === 'b')?.vectorScore).toBeUndefined();
  });

  it('scores the first position as 1/(k+1), not 1/k', () => {
    // Off by one here is not cosmetic: dividing by k alone would score rank 1
    // and a hypothetical rank 0 identically, and every subsequent gap shifts.
    const result = fuse({ vector: [scored('a', 0.9)], text: [], limit: 1 });

    expect(result[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('adds one contribution per ranking', () => {
    const result = fuse({ vector: [scored('a', 0.9)], text: [chunk('a')], limit: 1 });

    expect(result[0]?.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('separates chunks of the same document by their index', () => {
    // A document is not the unit of retrieval. Keying on documentId alone
    // would collapse every chunk of a long document into one result.
    const result = fuse({
      vector: [
        { documentId: 'd', chunkIndex: 0, score: 0.9 },
        { documentId: 'd', chunkIndex: 4, score: 0.8 },
      ],
      text: [],
      limit: 5,
    });

    expect(result).toHaveLength(2);
    expect(result.map((hit) => hit.chunkIndex).sort()).toEqual([0, 4]);
  });

  it('honours the limit', () => {
    const result = fuse({
      vector: [scored('a', 0.9), scored('b', 0.8), scored('c', 0.7)],
      text: [chunk('d'), chunk('e')],
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });

  it('answers the same order twice for the same input', () => {
    // Ties are ordinary here -- two chunks each found once at the same
    // position score identically -- and an unstable order would read as
    // flakiness to anyone comparing two runs.
    const input = {
      vector: [scored('a', 0.5), scored('b', 0.5)],
      text: [chunk('c'), chunk('d')],
      limit: 4,
    };

    expect(ids(fuse(input))).toEqual(ids(fuse(input)));
  });

  it('breaks a tie towards the chunk both rankings found', () => {
    // `a` is second in each list; `b` is first in one and absent from the
    // other. The arithmetic can land level -- agreement decides it.
    const result = fuse({
      vector: [scored('b', 0.9), scored('a', 0.5)],
      text: [chunk('x'), chunk('a')],
      limit: 4,
    });

    const positions = ids(result);
    expect(positions.indexOf('a')).toBeLessThan(positions.indexOf('b'));
  });

  it('returns nothing when neither ranking found anything', () => {
    expect(fuse({ vector: [], text: [], limit: 5 })).toEqual([]);
  });

  it('returns nothing for a limit of zero rather than everything', () => {
    // `slice(0, 0)` is empty but `slice(0, -1)` is not, and a negative limit
    // arriving here would quietly return the whole candidate set.
    expect(fuse({ vector: [scored('a', 0.9)], text: [], limit: 0 })).toEqual([]);
    expect(fuse({ vector: [scored('a', 0.9)], text: [], limit: -3 })).toEqual([]);
  });
});
