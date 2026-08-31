import { InternalError } from '@aia/errors';

import type { StoreAccess } from './store-access.js';

/**
 * The filter a search MUST be executed with.
 *
 * ADR-006 chose Qdrant because its payload filter runs DURING the vector
 * search. Filtering afterwards leaks results -- the excluded chunks were still
 * candidates, so they consumed slots, skewed scores and broke pagination. The
 * lexical ranking (ADR-022) applies the same spec inside its own query, for
 * the same reason.
 *
 * This is a spec, not a predicate: it describes what an index has to apply,
 * and there is deliberately no method here that filters a list of results. An
 * adapter translates it; nothing can "forget" to.
 */
export interface TrimmingSpec {
  /**
   * The project that OWNS the store -- not necessarily the one asking.
   *
   * A shared store's chunks are still the owner's, so the tenant clause pins
   * the owner. That keeps two clauses fixed to single values whoever reads,
   * and it keeps Qdrant's `is_tenant` co-location doing its job: a
   * cross-project search still lands in exactly one tenant's partition.
   */
  readonly projectId: string;
  readonly storeId: string;
  /** Who is asking. Reported in logs; see `aclPrincipals` for the filter. */
  readonly principalId: string;
  /** ACL groups the caller satisfies. EMPTY across a project boundary. */
  readonly aclGroups: readonly string[];
  /** ACL principals the caller satisfies. EMPTY across a project boundary. */
  readonly aclPrincipals: readonly string[];
  /** Whether the reader is a subscriber rather than the owner. */
  readonly crossProject: boolean;
}

/**
 * Builds the spec, refusing anything that could match too much.
 *
 * Across a project boundary the identity branches are emptied here rather than
 * in each translation. A group is a role held IN a project, so it means
 * nothing in another one; and a document named for a principal was restricted
 * by its owner inside their own project, not offered to every project that
 * subscribes. Only public documents cross (ADR-023).
 *
 * Emptying them at the source is what makes that rule unforgettable: an
 * adapter has no `crossProject` branch to get wrong, because the lists it
 * translates are already empty.
 */
export function trimmingSpecFor(input: {
  requestingProjectId: string;
  store: { id: string; projectId: string };
  access: StoreAccess;
  principalId: string;
  principalGroups: readonly string[];
}): TrimmingSpec {
  const requesting = input.requestingProjectId.trim();
  const owner = input.store.projectId.trim();

  // A filter that could match everything must not be constructible. If any of
  // these fires it is a wiring mistake, and the alternative is a query with no
  // tenant boundary at all.
  if (requesting === '') {
    throw new InternalError('a search was built with no project to filter on');
  }
  if (owner === '') {
    throw new InternalError('a search was built for a store with no owning project');
  }
  if (input.principalId.trim() === '') {
    throw new InternalError('a search was built with no principal to trim for');
  }

  // The access decision and the ids have to tell the same story. They are
  // derived separately, and the moment they disagree one of them is wrong --
  // which is the shape every cross-tenant read has.
  if (input.access === 'owner' && owner !== requesting) {
    throw new InternalError('a search claimed ownership of a store in another project');
  }
  if (input.access === 'shared' && owner === requesting) {
    throw new InternalError('a search treated its own project as a subscriber');
  }

  const crossProject = input.access === 'shared';

  return {
    projectId: owner,
    storeId: input.store.id,
    principalId: input.principalId,
    aclGroups: crossProject ? [] : [...new Set(input.principalGroups)],
    aclPrincipals: crossProject ? [] : [input.principalId],
    crossProject,
  };
}
