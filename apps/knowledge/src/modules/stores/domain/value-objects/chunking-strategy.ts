import { InvalidStoreError } from '../errors/index.js';

export const CHUNK_KINDS = ['fixed', 'recursive', 'markdown-heading'] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

const MIN_TOKENS = 64;
const MAX_TOKENS = 2048;

/**
 * How a document is cut into chunks.
 *
 * A value object rather than three loose numbers, because the combination is
 * what has to be valid: an overlap at or above the window never advances, and
 * the chunker would loop forever. That rule belongs here, not in a `while`.
 */
export class ChunkingStrategy {
  private constructor(
    readonly kind: ChunkKind,
    readonly maxTokens: number,
    readonly overlapTokens: number,
  ) {}

  static of(input: {
    kind?: string;
    maxTokens?: number;
    overlapTokens?: number;
  }): ChunkingStrategy {
    const kind = (input.kind ?? 'markdown-heading') as ChunkKind;
    if (!CHUNK_KINDS.includes(kind)) {
      throw new InvalidStoreError(`Unknown chunking strategy "${input.kind ?? ''}"`);
    }

    const maxTokens = input.maxTokens ?? 512;
    const overlapTokens = input.overlapTokens ?? 64;

    if (!Number.isInteger(maxTokens) || maxTokens < MIN_TOKENS || maxTokens > MAX_TOKENS) {
      throw new InvalidStoreError(
        `max_tokens must be an integer between ${MIN_TOKENS.toString()} and ${MAX_TOKENS.toString()}`,
      );
    }
    if (!Number.isInteger(overlapTokens) || overlapTokens < 0) {
      throw new InvalidStoreError('overlap_tokens must be zero or a positive integer');
    }
    if (overlapTokens >= maxTokens) {
      throw new InvalidStoreError(
        'overlap_tokens must be smaller than max_tokens, or a chunk never advances',
      );
    }

    return new ChunkingStrategy(kind, maxTokens, overlapTokens);
  }

  static default(): ChunkingStrategy {
    return ChunkingStrategy.of({});
  }
}
