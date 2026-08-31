import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

export class StoreNotFoundError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.STORE_NOT_FOUND;
  readonly status = 404;

  constructor(storeId: string, projectId: string) {
    // A store from another project answers 404, not 403: confirming that it
    // exists would hand over information about the neighbouring tenant.
    super('No such vector store in this project', { store_id: storeId, project_id: projectId });
  }
}

export class DocumentNotFoundError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.DOCUMENT_NOT_FOUND;
  readonly status = 404;

  constructor(documentId: string) {
    super('No such document in this store', { document_id: documentId });
  }
}

export class UnsupportedMediaTypeError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
  readonly status = 415;

  constructor(mimeType: string) {
    super('No parser is configured for this document type', { mime_type: mimeType });
  }
}

/**
 * The router may fail over between deployments within one alias, and a
 * different provider means a different vector width. Writing that into the
 * index would corrupt it silently, and a corrupt vector index is undetectable
 * from the outside -- so the job fails instead.
 */
export class EmbeddingDimensionMismatchError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.EMBEDDING_DIMENSION_MISMATCH;
  readonly status = 502;

  constructor(expected: number, actual: number) {
    super('The embedding does not match the width this store was built for', {
      expected_dimensions: expected,
      actual_dimensions: actual,
    });
  }
}

export class IngestionFailedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INGESTION_FAILED;
  readonly status = 500;

  constructor(reason: string) {
    super(reason);
  }
}

export class InvalidStoreError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(reason: string) {
    super(reason);
  }
}
