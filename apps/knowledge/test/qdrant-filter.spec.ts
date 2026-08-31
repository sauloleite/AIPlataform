import { describe, expect, it } from 'vitest';

import { filterFor } from '../src/modules/stores/infrastructure/qdrant/qdrant-vector-index.js';
import { trimmingSpecFor } from '../src/modules/stores/domain/services/security-trimming.js';

function filterFrom(principalGroups: string[] = []): Record<string, unknown> {
  return filterFor(
    trimmingSpecFor({
      requestingProjectId: 'p1',
      store: { id: 's1', projectId: 'p1' },
      access: 'owner' as const,
      principalId: 'user-1',
      principalGroups,
    }),
  );
}

/**
 * This translation is the one place where a wrong clause becomes a
 * cross-tenant read, so it is asserted directly rather than through Qdrant.
 */
describe('filterFor', () => {
  it('always requires the project and the store', () => {
    const must = filterFrom().must as Record<string, unknown>[];
    expect(must).toContainEqual({ key: 'project_id', match: { value: 'p1' } });
    expect(must).toContainEqual({ key: 'store_id', match: { value: 's1' } });
  });

  // The project clause is a `must`, never inside the `should`: one satisfied
  // ACL alternative must not be able to stand in for the tenant boundary.
  it('keeps the tenant clause out of the optional branch', () => {
    const must = filterFrom(['finance']).must as Record<string, unknown>[];
    const should = must.find((clause) => 'should' in clause)?.['should'] as Record<
      string,
      unknown
    >[];

    expect(should.some((clause) => clause['key'] === 'project_id')).toBe(false);
    expect(should.some((clause) => clause['key'] === 'store_id')).toBe(false);
  });

  it('admits a public chunk, one of my groups, or one named for me', () => {
    const must = filterFrom(['finance']).must as Record<string, unknown>[];
    const should = must.find((clause) => 'should' in clause)?.['should'] as Record<
      string,
      unknown
    >[];

    expect(should).toContainEqual({ key: 'acl_public', match: { value: true } });
    expect(should).toContainEqual({ key: 'acl_groups', match: { any: ['finance'] } });
    expect(should).toContainEqual({ key: 'acl_principals', match: { any: ['user-1'] } });
  });

  // An empty `any: []` matches nothing in Qdrant, which would be harmless here,
  // but omitting the clause keeps the filter honest about what it asks.
  it('omits the group clause when the caller has no groups', () => {
    const must = filterFrom([]).must as Record<string, unknown>[];
    const should = must.find((clause) => 'should' in clause)?.['should'] as Record<
      string,
      unknown
    >[];

    expect(should.some((clause) => clause['key'] === 'acl_groups')).toBe(false);
    expect(should).toContainEqual({ key: 'acl_principals', match: { any: ['user-1'] } });
  });
});
