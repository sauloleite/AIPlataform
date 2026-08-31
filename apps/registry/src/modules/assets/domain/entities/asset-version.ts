import { AssetVersionConflictError, PublishedVersionIsImmutableError } from '../errors/index.js';
import { validateDefinition } from '../services/definition-validators.js';
import type { AssetDefinition, AssetKind, VersionStatus } from '../value-objects/index.js';

export interface AssetVersionProps {
  assetId: string;
  version: number;
  status: VersionStatus;
  definition: AssetDefinition;
  /** Bumped on every draft edit. The guard against two editors, not the version. */
  revision: number;
  publishedAt?: Date;
  publishedBy?: string;
  updatedAt: Date;
}

/**
 * One version of an asset's definition.
 *
 * A draft is editable; a published version is frozen. That is the whole point:
 * `aia-agent-runtime` pins a published version for the length of a run, so a
 * definition changing underneath a run in flight is not a state this can reach.
 */
export class AssetVersion {
  private constructor(private readonly props: AssetVersionProps) {}

  static createDraft(input: {
    assetId: string;
    version: number;
    kind: AssetKind;
    definition: AssetDefinition;
    now: Date;
  }): AssetVersion {
    validateDefinition(input.kind, input.definition);
    return new AssetVersion({
      assetId: input.assetId,
      version: input.version,
      status: 'draft',
      definition: input.definition,
      revision: 1,
      updatedAt: input.now,
    });
  }

  static rehydrate(props: AssetVersionProps): AssetVersion {
    return new AssetVersion({ ...props });
  }

  get assetId(): string {
    return this.props.assetId;
  }
  get version(): number {
    return this.props.version;
  }
  get status(): VersionStatus {
    return this.props.status;
  }
  get definition(): AssetDefinition {
    return this.props.definition;
  }
  get revision(): number {
    return this.props.revision;
  }
  get publishedAt(): Date | undefined {
    return this.props.publishedAt;
  }
  get publishedBy(): string | undefined {
    return this.props.publishedBy;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get isDraft(): boolean {
    return this.props.status === 'draft';
  }

  /**
   * Replaces the definition of a draft.
   *
   * `expectedRevision` is what the editor last read. Refusing the write when it
   * has moved is the only way the second of two concurrent editors learns that
   * they would have overwritten the first.
   */
  edit(input: {
    kind: AssetKind;
    definition: AssetDefinition;
    expectedRevision: number;
    now: Date;
  }): void {
    if (!this.isDraft) throw new PublishedVersionIsImmutableError(this.props.version);
    if (input.expectedRevision !== this.props.revision) {
      throw new AssetVersionConflictError(input.expectedRevision, this.props.revision);
    }

    validateDefinition(input.kind, input.definition);
    this.props.definition = input.definition;
    this.props.revision += 1;
    this.props.updatedAt = input.now;
  }

  publish(input: { principalId: string; now: Date }): void {
    if (!this.isDraft) throw new PublishedVersionIsImmutableError(this.props.version);
    this.props.status = 'published';
    this.props.publishedAt = input.now;
    this.props.publishedBy = input.principalId;
    this.props.updatedAt = input.now;
  }

  deprecate(now: Date): void {
    // Deprecating a draft is meaningless -- nothing can be running it.
    if (this.props.status !== 'published') {
      throw new PublishedVersionIsImmutableError(this.props.version);
    }
    this.props.status = 'deprecated';
    this.props.updatedAt = now;
  }

  snapshot(): Readonly<AssetVersionProps> {
    return { ...this.props };
  }
}
