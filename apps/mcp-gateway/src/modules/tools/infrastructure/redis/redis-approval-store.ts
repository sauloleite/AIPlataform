import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type { ApprovalStore, PendingApproval } from '../../application/ports.js';

/**
 * Pending approvals in Redis, with a TTL.
 *
 * Redis rather than Mongo because the record is short-lived by design, and
 * the expiry IS the rule: an approval that outlives the intent behind it is a
 * signature on a blank cheque.
 */
@Injectable()
export class RedisApprovalStore implements ApprovalStore {
  constructor(private readonly redis: Redis) {}

  async open(approval: PendingApproval, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      keyFor(approval.projectId, approval.id),
      JSON.stringify({ ...approval, createdAt: approval.createdAt.toISOString() }),
      'EX',
      ttlSeconds,
    );
  }

  /**
   * Reads and DELETES in one step: an approval is good for exactly one call,
   * so a replay of the same approval id finds nothing.
   */
  async take(input: { projectId: string; approvalId: string }): Promise<PendingApproval | null> {
    const raw = await this.redis.getdel(keyFor(input.projectId, input.approvalId));
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as Omit<PendingApproval, 'createdAt'> & { createdAt: string };
      return { ...parsed, createdAt: new Date(parsed.createdAt) };
    } catch {
      return null;
    }
  }
}

function keyFor(projectId: string, approvalId: string): string {
  return `aia:tool-approval:${projectId}:${approvalId}`;
}
