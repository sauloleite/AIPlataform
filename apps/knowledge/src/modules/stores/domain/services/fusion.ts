/**
 * Reciprocal Rank Fusion: two rankings, one list.
 *
 * A vector search ranks by topic and a lexical one ranks by term, and the two
 * scores are not comparable -- cosine is bounded, MongoDB's textScore is not.
 * Normalising them per query would work only until a query whose worst result
 * is unusually bad, because min-max makes every score depend on the batch.
 *
 * RRF sidesteps that by throwing the scores away and keeping only POSITIONS.
 * A chunk both rankings place near the top beats a chunk one ranking loves and
 * the other has never heard of, which is exactly the judgement we want.
 */

/**
 * The damping constant from Cormack et al. (2009), where it was tuned and has
 * been the default ever since.
 *
 * It flattens the difference between the top few positions: with k = 60, rank 1
 * scores 1/61 and rank 2 scores 1/62, so being first in one ranking is worth
 * far less than appearing in both. A small k would let a single ranking's
 * favourite win outright and turn the fusion back into a one-legged search.
 */
export const RRF_K = 60;

export interface RankedChunk {
  documentId: string;
  chunkIndex: number;
}

export interface ScoredChunk extends RankedChunk {
  score: number;
}

/** Which ranking found a chunk. `both` is the strongest signal there is. */
export type Retrieval = 'vector' | 'text' | 'both';

export interface FusedChunk {
  documentId: string;
  chunkIndex: number;
  /** The fused score. Comparable within one response and nowhere else. */
  score: number;
  retrieval: Retrieval;
  /** Cosine, when the vector ranking reached it. */
  vectorScore?: number;
}

function keyOf(chunk: RankedChunk): string {
  return `${chunk.documentId}:${chunk.chunkIndex.toString()}`;
}

/**
 * Fuses the two rankings and keeps the best `limit`.
 *
 * Both inputs must arrive in rank order, best first -- position IS the input
 * here, so a caller that re-sorts them has changed the answer.
 */
export function fuse(input: {
  vector: readonly ScoredChunk[];
  text: readonly RankedChunk[];
  limit: number;
}): FusedChunk[] {
  const fused = new Map<string, FusedChunk>();

  const contribute = (chunk: RankedChunk, position: number, leg: 'vector' | 'text'): FusedChunk => {
    const key = keyOf(chunk);
    const existing = fused.get(key);
    // Rank is 1-based: the first result must not divide by k alone.
    const increment = 1 / (RRF_K + position + 1);

    if (existing === undefined) {
      const created: FusedChunk = {
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        score: increment,
        retrieval: leg,
      };
      fused.set(key, created);
      return created;
    }

    existing.score += increment;
    if (existing.retrieval !== leg) existing.retrieval = 'both';
    return existing;
  };

  input.vector.forEach((chunk, position) => {
    const entry = contribute(chunk, position, 'vector');
    entry.vectorScore = chunk.score;
  });
  input.text.forEach((chunk, position) => {
    contribute(chunk, position, 'text');
  });

  return [...fused.values()].sort(compare).slice(0, Math.max(0, input.limit));
}

/**
 * Ordering, decided all the way down.
 *
 * Ties are common -- two chunks each found by one ranking at the same position
 * score identically -- and an arbitrary order there would make the same query
 * answer differently between calls, which reads as flakiness and breaks any
 * test that names a result.
 */
function compare(left: FusedChunk, right: FusedChunk): number {
  if (right.score !== left.score) return right.score - left.score;

  // A chunk both rankings found outranks one only a single ranking saw, even
  // when the arithmetic came out level.
  const byLegs = legCount(right) - legCount(left);
  if (byLegs !== 0) return byLegs;

  const byVector = (right.vectorScore ?? -1) - (left.vectorScore ?? -1);
  if (byVector !== 0) return byVector;

  return keyOf(left).localeCompare(keyOf(right));
}

function legCount(chunk: FusedChunk): number {
  return chunk.retrieval === 'both' ? 2 : 1;
}
