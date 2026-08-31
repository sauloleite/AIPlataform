import { StoreNotFoundError } from '../errors/index.js';

/**
 * How a project reaches a store (ADR-023).
 *
 * `owner` is the project that created it and holds its documents. `shared` is
 * another project reading a store that was published AND that it subscribed
 * to -- two consents, one from each side.
 */
export type StoreAccess = 'owner' | 'shared';

/**
 * Decides whether a project may read a store at all.
 *
 * Refusal is `StoreNotFoundError`, not a forbidden: a project that may not
 * read a store must not be able to learn that it exists. A 403 answers "yes,
 * and it is not yours", which turns any id-guessing loop into a census of
 * every store on the platform.
 */
export function accessTo(input: {
  store: { id: string; projectId: string; isPublic: boolean };
  requestingProjectId: string;
  /** Whether the requesting project has accepted this store. */
  subscribed: boolean;
}): StoreAccess {
  const requesting = input.requestingProjectId.trim();
  if (requesting === '') {
    throw new StoreNotFoundError(input.store.id, input.requestingProjectId);
  }

  if (input.store.projectId === requesting) return 'owner';

  // Published but not accepted is not access. The catalogue lists the store so
  // somebody can decide to subscribe; until they do, its contents stay put.
  if (input.store.isPublic && input.subscribed) return 'shared';

  throw new StoreNotFoundError(input.store.id, input.requestingProjectId);
}
