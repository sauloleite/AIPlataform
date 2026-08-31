import { describe, expect, it } from 'vitest';

import {
  searchTermsOf,
  textQueryFor,
} from '../src/modules/stores/infrastructure/mongo/chunk.repository.js';
import { filterFor } from '../src/modules/stores/infrastructure/qdrant/qdrant-vector-index.js';
import { trimmingSpecFor } from '../src/modules/stores/domain/services/security-trimming.js';

function specFor(principalGroups: string[] = []) {
  return trimmingSpecFor({
    requestingProjectId: 'p1',
    store: { id: 's1', projectId: 'p1' },
    access: 'owner' as const,
    principalId: 'user-1',
    principalGroups,
  });
}

function queryFrom(principalGroups: string[] = []): Record<string, unknown> {
  return textQueryFor(specFor(principalGroups), '"handbook"');
}

/**
 * The lexical twin of `filterFor`. A wrong clause here is a cross-tenant read
 * exactly as it is over there, so it is asserted directly rather than through
 * a running MongoDB.
 */
describe('textQueryFor', () => {
  it('always requires the project and the store', () => {
    const query = queryFrom();

    expect(query['projectId']).toBe('p1');
    expect(query['storeId']).toBe('s1');
  });

  it('keeps the tenant clause out of the optional branch', () => {
    // One satisfied ACL alternative must not be able to stand in for the
    // tenant boundary. `$or` is where that mistake would live.
    const branches = queryFrom(['finance'])['$or'] as Record<string, unknown>[];

    expect(branches.some((branch) => 'projectId' in branch)).toBe(false);
    expect(branches.some((branch) => 'storeId' in branch)).toBe(false);
  });

  it('admits a public chunk, one of my groups, or one named for me', () => {
    const branches = queryFrom(['finance'])['$or'] as Record<string, unknown>[];

    expect(branches).toContainEqual({ aclPublic: true });
    expect(branches).toContainEqual({ aclGroups: { $in: ['finance'] } });
    expect(branches).toContainEqual({ aclPrincipals: { $in: ['user-1'] } });
  });

  it('drops the group branch when the caller has no group', () => {
    // `$in: []` matches nothing, so leaving it in would be harmless. It is
    // dropped so the query reads as what it means.
    const branches = queryFrom()['$or'] as Record<string, unknown>[];

    expect(branches).toHaveLength(2);
    expect(branches.some((branch) => 'aclGroups' in branch)).toBe(false);
  });

  /**
   * The two translations decide the same question for the same caller. If one
   * admits a chunk the other refuses, hybrid search leaks in whichever
   * direction the disagreement runs -- so they are compared, not just each
   * checked alone.
   */
  it('admits exactly what the vector filter admits', () => {
    const spec = specFor(['finance', 'legal']);
    const lexical = textQueryFor(spec, '"x"') as Record<string, unknown>;
    const vector = filterFor(spec)['must'] as Record<string, unknown>[];

    const vectorShould = vector.find((clause) => 'should' in clause)?.['should'] as Record<
      string,
      unknown
    >[];
    const lexicalOr = lexical['$or'] as Record<string, unknown>[];

    // Same tenant pair, as a hard requirement on both sides.
    expect(lexical['projectId']).toBe('p1');
    expect(vector).toContainEqual({ key: 'project_id', match: { value: 'p1' } });
    expect(lexical['storeId']).toBe('s1');
    expect(vector).toContainEqual({ key: 'store_id', match: { value: 's1' } });

    // Same number of ACL alternatives: public, my groups, my name.
    expect(lexicalOr).toHaveLength(vectorShould.length);
  });
});

describe('searchTermsOf', () => {
  it('quotes each term so a delimiter inside it survives tokenisation', () => {
    // MongoDB splits on delimiters, so an unquoted `tool_not_allowed` can
    // become three terms and match a chunk that merely says "allowed".
    expect(searchTermsOf('tool_not_allowed')).toBe('"tool_not_allowed"');
  });

  it('keeps several terms separate rather than making one phrase', () => {
    expect(searchTermsOf('audit retention')).toBe('"audit" "retention"');
  });

  it('neutralises a leading minus instead of excluding the term', () => {
    // In MongoDB's text syntax a `-` prefix means "must NOT contain". A query
    // pasted from a log would otherwise exclude what it was looking for.
    expect(searchTermsOf('-1 error')).toBe('"-1" "error"');
  });

  it('strips embedded quotes so a term cannot close its own phrase', () => {
    expect(searchTermsOf('say"hello')).toBe('"sayhello"');
  });

  it('answers empty for a query that is only whitespace', () => {
    expect(searchTermsOf('   ')).toBe('');
  });
});
