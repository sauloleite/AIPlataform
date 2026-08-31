import { InvalidStoreError } from '../errors/index.js';

/**
 * Who may see a document, within the project that owns it.
 *
 * The project boundary is not expressed here: it is not an ACL decision but a
 * tenancy one, and it applies before any of this (see SecurityTrimming).
 */
export class DocumentAcl {
  private constructor(
    readonly isPublic: boolean,
    readonly groups: readonly string[],
    readonly principals: readonly string[],
  ) {}

  static of(input: {
    isPublic?: boolean;
    groups?: readonly string[];
    principals?: readonly string[];
  }): DocumentAcl {
    const isPublic = input.isPublic ?? true;
    const groups = dedupe(input.groups ?? []);
    const principals = dedupe(input.principals ?? []);

    // A restricted document naming nobody is reachable by nobody. That is an
    // invisible bug that looks exactly like an empty search result, so it is
    // refused at construction rather than discovered months later.
    if (!isPublic && groups.length === 0 && principals.length === 0) {
      throw new InvalidStoreError(
        'A non-public document must name at least one group or principal',
      );
    }

    return new DocumentAcl(isPublic, groups, principals);
  }

  /** Readable by every member of the project. */
  static publicToProject(): DocumentAcl {
    return new DocumentAcl(true, [], []);
  }

  /**
   * Whether a principal may read it.
   *
   * The index already filters, so this is defence in depth: if the two ever
   * disagree, the discrepancy is a leak and the caller logs it loudly.
   */
  allows(principalId: string, groups: readonly string[]): boolean {
    if (this.isPublic) return true;
    if (this.principals.includes(principalId)) return true;
    return groups.some((group) => this.groups.includes(group));
  }

  toPayload(): { acl_public: boolean; acl_groups: string[]; acl_principals: string[] } {
    return {
      acl_public: this.isPublic,
      acl_groups: [...this.groups],
      acl_principals: [...this.principals],
    };
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
