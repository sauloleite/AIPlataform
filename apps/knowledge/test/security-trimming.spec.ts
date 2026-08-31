import { describe, expect, it } from 'vitest';

import { DocumentAcl } from '../src/modules/stores/domain/value-objects/document-acl.js';
import { InvalidStoreError } from '../src/modules/stores/domain/errors/index.js';
import { trimmingSpecFor } from '../src/modules/stores/domain/services/security-trimming.js';

const store = { id: 's1', projectId: 'p1' };

describe('SecurityTrimming.specFor', () => {
  it('carries the project, the store and the caller into the filter', () => {
    const spec = trimmingSpecFor({
      requestingProjectId: 'p1',
      store,
      access: 'owner',
      principalId: 'user-1',
      principalGroups: ['finance', 'finance'],
    });

    expect(spec.projectId).toBe('p1');
    expect(spec.storeId).toBe('s1');
    expect(spec.principalId).toBe('user-1');
    expect(spec.aclGroups).toEqual(['finance']);
    expect(spec.aclPrincipals).toEqual(['user-1']);
    expect(spec.crossProject).toBe(false);
  });

  // The whole point of ADR-006: a filter that could match everything must not
  // be constructible, so a wiring mistake cannot become a cross-tenant read.
  it('refuses to build a filter with no project', () => {
    expect(() =>
      trimmingSpecFor({
        requestingProjectId: '   ',
        store,
        access: 'owner',
        principalId: 'user-1',
        principalGroups: [],
      }),
    ).toThrow();
  });

  it('refuses to build a filter for a store with no owning project', () => {
    expect(() =>
      trimmingSpecFor({
        requestingProjectId: 'p1',
        store: { id: 's1', projectId: '  ' },
        access: 'owner',
        principalId: 'user-1',
        principalGroups: [],
      }),
    ).toThrow();
  });

  it('refuses to build a filter with no principal to trim for', () => {
    expect(() =>
      trimmingSpecFor({
        requestingProjectId: 'p1',
        store,
        access: 'owner',
        principalId: '',
        principalGroups: [],
      }),
    ).toThrow();
  });

  // The access decision and the ids are derived separately. The moment they
  // disagree one of them is wrong, and that is the shape of a leak.
  it('refuses to claim ownership of a store in another project', () => {
    expect(() =>
      trimmingSpecFor({
        requestingProjectId: 'p2',
        store,
        access: 'owner',
        principalId: 'user-1',
        principalGroups: [],
      }),
    ).toThrow();
  });

  it('refuses to treat its own project as a subscriber', () => {
    expect(() =>
      trimmingSpecFor({
        requestingProjectId: 'p1',
        store,
        access: 'shared',
        principalId: 'user-1',
        principalGroups: [],
      }),
    ).toThrow();
  });
});

/**
 * A subscriber reads the owner's chunks, so the tenant clause has to pin the
 * OWNER -- and the identity branches have to disappear, because a role held in
 * one project says nothing about a document restricted inside another.
 */
describe('SecurityTrimming across a project boundary', () => {
  const shared = () =>
    trimmingSpecFor({
      requestingProjectId: 'p2',
      store,
      access: 'shared',
      principalId: 'user-1',
      principalGroups: ['finance', 'project_owner'],
    });

  it('filters on the owning project, not on the one asking', () => {
    expect(shared().projectId).toBe('p1');
  });

  it('drops the caller groups, so only public documents can match', () => {
    // `finance` in p2 is a different thing from `finance` in p1. Carrying it
    // over would hand a subscriber somebody else's restricted documents.
    expect(shared().aclGroups).toEqual([]);
  });

  it('drops the principal branch too', () => {
    // A document named for a user was restricted by its owner inside their own
    // project. Subscribing to the store is not that owner's consent.
    expect(shared().aclPrincipals).toEqual([]);
  });

  it('still reports who is asking, for the log that says so', () => {
    expect(shared().principalId).toBe('user-1');
    expect(shared().crossProject).toBe(true);
  });
});

describe('DocumentAcl', () => {
  it('lets anyone in the project read a public document', () => {
    expect(DocumentAcl.publicToProject().allows('anyone', [])).toBe(true);
  });

  it('lets a named principal or a member of a named group read it', () => {
    const acl = DocumentAcl.of({ isPublic: false, groups: ['finance'], principals: ['user-1'] });
    expect(acl.allows('user-1', [])).toBe(true);
    expect(acl.allows('user-2', ['finance'])).toBe(true);
    expect(acl.allows('user-2', ['legal'])).toBe(false);
  });

  // A document nobody can reach looks exactly like an empty search result, so
  // it is refused at construction rather than discovered months later.
  it('refuses a restricted document that names nobody', () => {
    expect(() => DocumentAcl.of({ isPublic: false })).toThrow(InvalidStoreError);
    expect(() => DocumentAcl.of({ isPublic: false, groups: ['  '] })).toThrow(InvalidStoreError);
  });

  it('maps to the payload the index filters on', () => {
    const payload = DocumentAcl.of({
      isPublic: false,
      groups: ['finance'],
      principals: ['user-1'],
    }).toPayload();

    expect(payload).toEqual({
      acl_public: false,
      acl_groups: ['finance'],
      acl_principals: ['user-1'],
    });
  });
});
