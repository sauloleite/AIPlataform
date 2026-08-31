import { InvalidStoreError } from '../errors/index.js';
import type { ChunkingStrategy } from '../value-objects/chunking-strategy.js';

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Whether another project may reuse this store (ADR-023).
 *
 * `public` is only the owner's half of the bargain: it offers the store to the
 * catalogue. Nothing crosses until the consuming project subscribes, so
 * publishing by mistake exposes a listing, not the contents.
 */
export type StoreVisibility = 'private' | 'public';

export interface VectorStoreProps {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  embeddingAlias: string;
  embeddingModel: string;
  dimensions: number;
  distance: 'cosine' | 'dot';
  chunking: ChunkingStrategy;
  visibility: StoreVisibility;
  /** Derived once, so a later change to the naming scheme cannot orphan data. */
  collectionName: string;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A vector store: what was indexed, with what, and how it was cut up.
 *
 * The embedding model and its width are FIXED at creation. Changing the model
 * invalidates every vector already written, so that is a new store rather than
 * an edit -- there is deliberately no setter for it.
 */
export class VectorStore {
  private constructor(private readonly props: VectorStoreProps) {}

  static create(input: {
    id: string;
    projectId: string;
    slug: string;
    name: string;
    description?: string;
    embeddingAlias: string;
    embeddingModel: string;
    dimensions: number;
    chunking: ChunkingStrategy;
    now: Date;
    distance?: 'cosine' | 'dot';
  }): VectorStore {
    if (!SLUG_PATTERN.test(input.slug)) {
      throw new InvalidStoreError(
        'A slug is lowercase letters, digits and hyphens, 3 to 64 characters, not starting or ending with a hyphen',
      );
    }
    if (input.name.trim().length === 0) throw new InvalidStoreError('A store needs a name');
    if (input.projectId.trim().length === 0) {
      throw new InvalidStoreError('A store needs a project');
    }
    if (!Number.isInteger(input.dimensions) || input.dimensions < 1) {
      throw new InvalidStoreError('The embedding width must be a positive integer');
    }

    const distance = input.distance ?? 'cosine';
    return new VectorStore({
      ...input,
      description: input.description,
      distance,
      // Private until somebody decides otherwise. A default that shares is a
      // default that leaks the first time nobody reads the form.
      visibility: 'private',
      collectionName: collectionNameFor(input.dimensions, distance),
      documentCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(props: VectorStoreProps): VectorStore {
    return new VectorStore({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get projectId(): string {
    return this.props.projectId;
  }
  get slug(): string {
    return this.props.slug;
  }
  get name(): string {
    return this.props.name;
  }
  get embeddingAlias(): string {
    return this.props.embeddingAlias;
  }
  get embeddingModel(): string {
    return this.props.embeddingModel;
  }
  get dimensions(): number {
    return this.props.dimensions;
  }
  get distance(): 'cosine' | 'dot' {
    return this.props.distance;
  }
  get chunking(): ChunkingStrategy {
    return this.props.chunking;
  }
  get collectionName(): string {
    return this.props.collectionName;
  }
  get documentCount(): number {
    return this.props.documentCount;
  }
  get visibility(): StoreVisibility {
    return this.props.visibility;
  }
  get isPublic(): boolean {
    return this.props.visibility === 'public';
  }

  /**
   * Offers the store to other projects, or withdraws the offer.
   *
   * A transition rather than a setter, because withdrawing has a consequence
   * the caller must handle: existing subscriptions stop resolving, and a
   * search from a subscribed project starts refusing. The use case cleans them
   * up; the entity refuses to pretend that is a field assignment.
   */
  changeVisibility(visibility: StoreVisibility, now: Date): void {
    if (this.props.visibility === visibility) return;
    this.props.visibility = visibility;
    this.props.updatedAt = now;
  }

  countDocument(delta: number, now: Date): void {
    this.props.documentCount = Math.max(0, this.props.documentCount + delta);
    this.props.updatedAt = now;
  }

  snapshot(): Readonly<VectorStoreProps> {
    return { ...this.props };
  }
}

/**
 * One collection per embedding SHAPE, not one per store (ADR-016).
 *
 * A collection per store is the obvious reading and the wrong one: it pushes
 * the tenant boundary into the collection NAME, so a bug in name derivation
 * becomes a cross-tenant leak with no filter left to catch it. Qdrant's own
 * guidance says the same for a different reason -- each collection carries its
 * own segments and HNSW graph, and thousands of them is an operational problem
 * for no benefit.
 *
 * A collection cannot hold vectors of two widths, so the width is in the name.
 */
export function collectionNameFor(dimensions: number, distance: 'cosine' | 'dot'): string {
  return `aia_chunks_${dimensions.toString()}_${distance}`;
}
