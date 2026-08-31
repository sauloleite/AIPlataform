import { describe, expect, it } from 'vitest';

import { hashArguments } from '../src/modules/tools/application/use-cases/invoke-tool.js';

/**
 * Approval is bound to the ARGUMENTS, not just the tool.
 *
 * Otherwise a human approves "read ticket 42" and the caller replays that
 * approval with "delete everything": the signature has to cover what was
 * signed for.
 */
describe('hashArguments', () => {
  it('is stable however the object was built', () => {
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }));
  });

  it('is stable through nesting', () => {
    expect(hashArguments({ outer: { x: 1, y: [1, 2] } })).toBe(
      hashArguments({ outer: { y: [1, 2], x: 1 } }),
    );
  });

  it('changes when any argument changes', () => {
    const approved = hashArguments({ action: 'read', id: 42 });
    expect(hashArguments({ action: 'delete', id: 42 })).not.toBe(approved);
    expect(hashArguments({ action: 'read', id: 43 })).not.toBe(approved);
    expect(hashArguments({ action: 'read' })).not.toBe(approved);
  });

  // Order matters in a list even though it does not in an object: [1,2] and
  // [2,1] are different arguments.
  it('respects array order', () => {
    expect(hashArguments({ ids: [1, 2] })).not.toBe(hashArguments({ ids: [2, 1] }));
  });

  it('distinguishes a missing key from an explicit null', () => {
    expect(hashArguments({ a: null })).not.toBe(hashArguments({}));
  });

  it('distinguishes types that stringify alike', () => {
    expect(hashArguments({ v: 1 })).not.toBe(hashArguments({ v: '1' }));
    expect(hashArguments({ v: true })).not.toBe(hashArguments({ v: 'true' }));
  });
});
