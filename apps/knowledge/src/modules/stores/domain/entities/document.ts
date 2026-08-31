import { InvalidStoreError } from '../errors/index.js';
import type { DocumentAcl } from '../value-objects/document-acl.js';

export const INGESTION_STATUSES = [
  'pending',
  'parsing',
  'chunking',
  'embedding',
  'indexing',
  'ingested',
  'failed',
] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

/** The stages a job moves through, in order. Terminal states sit outside it. */
const PIPELINE: IngestionStatus[] = ['pending', 'parsing', 'chunking', 'embedding', 'indexing'];

export interface DocumentProps {
  id: string;
  projectId: string;
  storeId: string;
  title: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  version: number;
  status: IngestionStatus;
  errorCode?: string;
  chunkCount: number;
  acl: DocumentAcl;
  ownerPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
  ingestedAt?: Date;
}

/**
 * A document in a store, and where its ingestion has got to.
 *
 * The status is a state machine on the entity, like `Run` in the agent
 * runtime: it refuses to go backwards, so a late worker message cannot drag an
 * ingested document back to `parsing`.
 */
export class Document {
  private constructor(private readonly props: DocumentProps) {}

  static register(input: {
    id: string;
    projectId: string;
    storeId: string;
    title: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    acl: DocumentAcl;
    ownerPrincipalId: string;
    now: Date;
  }): Document {
    if (input.title.trim().length === 0) throw new InvalidStoreError('A document needs a title');
    if (input.mimeType.trim().length === 0) {
      throw new InvalidStoreError('A document needs a media type');
    }

    return new Document({
      ...input,
      version: 1,
      status: 'pending',
      chunkCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(props: DocumentProps): Document {
    return new Document({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get projectId(): string {
    return this.props.projectId;
  }
  get storeId(): string {
    return this.props.storeId;
  }
  get title(): string {
    return this.props.title;
  }
  get objectKey(): string {
    return this.props.objectKey;
  }
  get mimeType(): string {
    return this.props.mimeType;
  }
  get sizeBytes(): number {
    return this.props.sizeBytes;
  }
  get contentHash(): string | undefined {
    return this.props.contentHash;
  }
  get version(): number {
    return this.props.version;
  }
  get status(): IngestionStatus {
    return this.props.status;
  }
  get acl(): DocumentAcl {
    return this.props.acl;
  }
  get chunkCount(): number {
    return this.props.chunkCount;
  }
  get isTerminal(): boolean {
    return this.props.status === 'ingested' || this.props.status === 'failed';
  }

  /**
   * Moves to the next stage.
   *
   * Refuses to go backwards: a retried or delayed worker message must not drag
   * an already-ingested document back into the pipeline.
   */
  advance(to: IngestionStatus, now: Date): void {
    const from = PIPELINE.indexOf(this.props.status);
    const next = PIPELINE.indexOf(to);
    if (next === -1) throw new InvalidStoreError(`"${to}" is not a pipeline stage`);
    if (from === -1 || next <= from) {
      throw new InvalidStoreError(`Cannot move from ${this.props.status} to ${to}`);
    }

    this.props.status = to;
    this.props.updatedAt = now;
  }

  markIngested(input: { contentHash: string; chunkCount: number; now: Date }): void {
    this.props.contentHash = input.contentHash;
    this.props.chunkCount = input.chunkCount;
    this.props.status = 'ingested';
    this.props.ingestedAt = input.now;
    this.props.updatedAt = input.now;
    delete this.props.errorCode;
  }

  fail(errorCode: string, now: Date): void {
    this.props.status = 'failed';
    this.props.errorCode = errorCode;
    this.props.updatedAt = now;
  }

  /** A re-upload of new bytes reindexes: the version guards the old vectors. */
  startReingestion(now: Date): void {
    this.props.version += 1;
    this.props.status = 'pending';
    this.props.chunkCount = 0;
    delete this.props.errorCode;
    this.props.updatedAt = now;
  }

  snapshot(): Readonly<DocumentProps> {
    return { ...this.props };
  }
}
