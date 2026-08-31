import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

export class AssetNotFoundError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.ASSET_NOT_FOUND;
  readonly status = 404;

  constructor(assetId: string, projectId: string) {
    // An asset from another project answers 404, not 403: confirming that it
    // exists would hand over information about the neighbouring tenant.
    super('No such asset in this project', { asset_id: assetId, project_id: projectId });
  }
}

export class AssetNotPublishedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.ASSET_NOT_PUBLISHED;
  readonly status = 404;

  constructor(assetId: string) {
    super('The asset has no published version', { asset_id: assetId });
  }
}

/**
 * Two editors on one draft. Losing a change silently is worse than refusing the
 * second write, so the second write is refused.
 */
export class AssetVersionConflictError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.ASSET_VERSION_CONFLICT;
  readonly status = 409;

  constructor(expected: number, actual: number) {
    super('The draft changed while it was being edited', {
      expected_version: expected,
      actual_version: actual,
    });
  }
}

export class SlugTakenError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(kind: string, slug: string) {
    super('An asset of this kind already uses this slug', { kind, slug });
  }
}

export class NoDraftError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(assetId: string) {
    super('The asset has no open draft', { asset_id: assetId });
  }
}

export class PublishedVersionIsImmutableError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(version: number) {
    super('A published version cannot be edited', { version });
  }
}

/**
 * Publishing validates every reference the definition makes, so an unknown tool
 * or vector store fails here rather than at the first run.
 */
export class UnresolvedReferenceError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(references: readonly string[]) {
    super('The definition references something that does not exist', {
      unresolved: [...references],
    });
  }
}

export class InvalidDefinitionError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(reason: string) {
    super(reason);
  }
}
