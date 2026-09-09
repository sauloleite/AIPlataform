import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@aia/errors';
import { AUDIT_REPOSITORY, type AuditRecord, type AuditRepository } from '../ports.js';

/**
 * One inference call, as the audit recorded it.
 *
 * The platform kept this from the first day and no interface ever read it, so
 * the only way to see what a call actually said was a `mongosh` prompt. That is
 * the missing half of every quality conversation: a trace says a call took 2.4
 * seconds and cost 300 micros, and cannot say whether the answer was any good.
 *
 * What comes back is the REDACTED content, and only if the project asked for
 * content to be kept at all. `contentCaptured` says which of those two silences
 * an empty prompt is — "the project does not keep content" and "the record has
 * expired" are different answers, and reporting them the same way sends
 * somebody to change a setting that is already right.
 */
export interface CompletionRecordQuery {
  projectId: string;
  requestId: string;
}

@Injectable()
export class ReadCompletionRecord {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository) {}

  async execute(query: CompletionRecordQuery): Promise<AuditRecord> {
    const record = await this.audit.find(query.projectId, query.requestId);

    // A record from another project answers 404 rather than 403: confirming
    // that a request id exists is already a fact about the neighbouring tenant,
    // and this one carries their content.
    if (record === null) {
      throw new NotFoundError('Inference record', query.requestId);
    }

    return record;
  }
}
