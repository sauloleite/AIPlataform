import { InvalidDefinitionError } from '../errors/index.js';
import { ASSET_KINDS, SLUG_PATTERN, type AssetKind } from '../value-objects/index.js';

export interface AssetProps {
  id: string;
  projectId: string;
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  ownerPrincipalId: string;
  publishedVersion?: number;
  draftVersion?: number;
  latestVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An AI asset: what it is called, who owns it, and which of its versions is
 * live. The definitions themselves live in AssetVersion.
 *
 * The project is the tenant here as everywhere: no asset exists outside one,
 * and the slug is unique per project and kind, not globally.
 */
export class Asset {
  private constructor(private readonly props: AssetProps) {}

  static create(input: {
    id: string;
    projectId: string;
    kind: AssetKind;
    slug: string;
    name: string;
    description?: string;
    ownerPrincipalId: string;
    now: Date;
  }): Asset {
    if (!ASSET_KINDS.includes(input.kind)) {
      throw new InvalidDefinitionError(`Unknown asset kind "${input.kind}"`);
    }
    if (!SLUG_PATTERN.test(input.slug)) {
      throw new InvalidDefinitionError(
        'A slug is lowercase letters, digits and hyphens, 3 to 64 characters, not starting or ending with a hyphen',
      );
    }
    if (input.name.trim().length === 0) {
      throw new InvalidDefinitionError('An asset needs a name');
    }
    if (input.projectId.trim().length === 0) {
      // Belt and braces: the guard already requires the header, but an asset
      // with no tenant is the one row that would be visible to everyone.
      throw new InvalidDefinitionError('An asset needs a project');
    }

    return new Asset({
      ...input,
      description: input.description,
      draftVersion: 1,
      latestVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(props: AssetProps): Asset {
    return new Asset({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get projectId(): string {
    return this.props.projectId;
  }
  get kind(): AssetKind {
    return this.props.kind;
  }
  get slug(): string {
    return this.props.slug;
  }
  get name(): string {
    return this.props.name;
  }
  get description(): string | undefined {
    return this.props.description;
  }
  get publishedVersion(): number | undefined {
    return this.props.publishedVersion;
  }
  get draftVersion(): number | undefined {
    return this.props.draftVersion;
  }
  get latestVersion(): number {
    return this.props.latestVersion;
  }

  rename(input: { name?: string; description?: string; now: Date }): void {
    if (input.name !== undefined) {
      if (input.name.trim().length === 0) throw new InvalidDefinitionError('An asset needs a name');
      this.props.name = input.name;
    }
    if (input.description !== undefined) this.props.description = input.description;
    this.props.updatedAt = input.now;
  }

  /**
   * Records that the draft became the published version.
   *
   * No next draft is opened here. Opening one eagerly made every freshly
   * published asset look like it had unpublished changes, because "a draft
   * exists above the published version" was then true from the moment of
   * publishing. A draft now appears only when somebody actually edits, so its
   * presence means what it says.
   */
  publishDraft(now: Date): { published: number } {
    const published = this.props.draftVersion ?? this.props.latestVersion;

    this.props.publishedVersion = published;
    this.props.draftVersion = undefined;
    this.props.latestVersion = Math.max(this.props.latestVersion, published);
    this.props.updatedAt = now;

    return { published };
  }

  /** Opens a draft above whatever is published. Called on the first edit. */
  openDraft(now: Date): number {
    if (this.props.draftVersion !== undefined) return this.props.draftVersion;
    return this.reopenDraft(now);
  }

  /**
   * Opens a NEW draft, whatever the current pointer says.
   *
   * Used when `draftVersion` points at something that is not a draft: an
   * inconsistent record should not wall the owner out of their own asset.
   */
  reopenDraft(now: Date): number {
    const next = Math.max(this.props.latestVersion, this.props.publishedVersion ?? 0) + 1;
    this.props.draftVersion = next;
    this.props.latestVersion = next;
    this.props.updatedAt = now;
    return next;
  }

  deprecatePublished(now: Date): void {
    this.props.publishedVersion = undefined;
    this.props.updatedAt = now;
  }

  snapshot(): Readonly<AssetProps> {
    return { ...this.props };
  }
}
