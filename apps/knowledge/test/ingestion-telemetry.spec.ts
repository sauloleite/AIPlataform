import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AIA_ATTR } from '@aia/telemetry';

import { IngestDocument } from '../src/modules/stores/application/use-cases/ingest-document.js';
import { BullMqIngestionQueue } from '../src/modules/stores/infrastructure/queue/bullmq-queue.js';
import { Document } from '../src/modules/stores/domain/entities/document.js';
import { DocumentAcl } from '../src/modules/stores/domain/value-objects/document-acl.js';
import { UnsupportedMediaTypeError } from '../src/modules/stores/domain/errors/index.js';
import type {
  DocumentRepository,
  IngestionJobPayload,
  VectorStoreRepository,
} from '../src/modules/stores/application/ports.js';

/**
 * A trace has to survive the queue.
 *
 * The ingestion worker is a separate process that picks a job up minutes after
 * the request that enqueued it has ended. Nothing carried the trace across, so
 * parse, chunk, embed and index ran under no span at all — and "why did this
 * document take four minutes" was a question a trace could not answer, for the
 * one operation in the platform slow enough to need asking.
 */

const NOW = new Date('2026-09-09T10:00:00Z');
const PAYLOAD: IngestionJobPayload = {
  projectId: 'proj-1',
  storeId: 'store-1',
  documentId: 'doc-1',
  accessToken: 'token',
};

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

function aDocument(mimeType = 'application/pdf'): Document {
  return Document.register({
    id: 'doc-1',
    projectId: 'proj-1',
    storeId: 'store-1',
    title: 'A runbook',
    objectKey: 'proj-1/store-1/doc-1',
    mimeType,
    sizeBytes: 12,
    acl: DocumentAcl.of({ isPublic: true }),
    ownerPrincipalId: 'user-ana',
    now: NOW,
  });
}

/**
 * Only the ports the early paths reach.
 *
 * The stages past parsing need an object store, a parser, an embedding client
 * and a vector index; this file is about the SPAN, and a document whose media
 * type nothing parses reaches the failure path having recorded its first stage.
 */
function build(document: Document | null, store: unknown = { id: 'store-1' }) {
  const saved: Document[] = [];
  const documents = {
    findById: () => Promise.resolve(document),
    save: (entity: Document) => {
      saved.push(entity);
      return Promise.resolve();
    },
  } as unknown as DocumentRepository;
  const stores = { findById: () => Promise.resolve(store) } as unknown as VectorStoreRepository;

  const useCase = new IngestDocument(
    stores,
    documents,
    {} as never,
    {} as never,
    [],
    {} as never,
    {} as never,
    'aia-documents',
    { now: () => NOW },
    { next: () => 'id-1', forChunk: () => 'chunk-1' },
  );
  return { useCase, saved };
}

function ingestionSpan() {
  return exporter.getFinishedSpans().find((span) => span.name === 'ingest_document');
}

describe('the ingestion span', () => {
  it('exists, and says which document in which project', async () => {
    const { useCase } = build(aDocument());

    await expect(useCase.execute(PAYLOAD)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);

    const span = ingestionSpan();
    expect(span, 'the ingestion produced no span').toBeDefined();
    expect(span?.attributes[AIA_ATTR.PROJECT_ID]).toBe('proj-1');
    expect(span?.attributes['aia.document.id']).toBe('doc-1');
  });

  it('marks the stage it reached', async () => {
    const { useCase } = build(aDocument());

    await expect(useCase.execute(PAYLOAD)).rejects.toThrow();

    // Events rather than four nested spans: a bulk import would otherwise
    // quadruple its trace volume to answer the one question anybody asks, and
    // an event timeline answers it inside a single span.
    //
    // Filtered to the stage vocabulary, because `recordSpanError` adds an
    // `exception` event of its own and this assertion is about the timeline.
    const stages = ['parsing', 'chunking', 'embedding', 'indexing'];
    const recorded = (ingestionSpan()?.events ?? [])
      .map((event) => event.name)
      .filter((name) => stages.includes(name));

    expect(recorded).toEqual(['parsing']);
  });

  it('records the failure with its stable code', async () => {
    const { useCase } = build(aDocument());

    await expect(useCase.execute(PAYLOAD)).rejects.toThrow();

    // An ingestion that fails silently is the worst case: the document sits at
    // `failed` in a list and the trace says nothing about why.
    expect(ingestionSpan()?.attributes[AIA_ATTR.ERROR_CODE]).toBe('unsupported_media_type');
  });

  it('ends the span even when the document is gone', async () => {
    const { useCase } = build(null);

    await expect(useCase.execute(PAYLOAD)).rejects.toThrow();

    // An unfinished span is never exported, so a leak here would look exactly
    // like an ingestion that never started.
    expect(ingestionSpan()).toBeDefined();
  });
});

describe('carrying the trace across the queue', () => {
  it('injects the enqueuing trace into the job', async () => {
    const added: { data: IngestionJobPayload }[] = [];
    const queue = new BullMqIngestionQueue({
      add: (_name: string, data: IngestionJobPayload) => {
        added.push({ data });
        return Promise.resolve();
      },
    } as never);

    const tracer = trace.getTracer('test');
    let expected = '';
    await tracer.startActiveSpan('POST /v1/stores/x/documents/y/complete', async (span) => {
      expected = span.spanContext().traceId;
      await queue.enqueue(PAYLOAD, 'key-1');
      span.end();
    });

    // The carrier, and not a `traceparent` field: which fields a trace needs is
    // the propagator's business, and a deployment adding baggage should not
    // have to change the job contract to carry it.
    const carrier = added[0]?.data.carrier;
    expect(carrier).toBeDefined();
    const restored = propagation.extract(context.active(), carrier ?? {});
    expect(trace.getSpan(restored)?.spanContext().traceId).toBe(expected);
  });

  it('is what makes the ingestion a child of the upload', async () => {
    const added: { data: IngestionJobPayload }[] = [];
    const queue = new BullMqIngestionQueue({
      add: (_name: string, data: IngestionJobPayload) => {
        added.push({ data });
        return Promise.resolve();
      },
    } as never);

    const tracer = trace.getTracer('test');
    let expected = '';
    await tracer.startActiveSpan('upload', async (span) => {
      expected = span.spanContext().traceId;
      await queue.enqueue(PAYLOAD, 'key-1');
      span.end();
    });

    // The worker, in another process and minutes later.
    const job = added[0]?.data;
    const parent = propagation.extract(context.active(), job?.carrier ?? {});
    const { useCase } = build(aDocument());
    await context.with(parent, () => useCase.execute(PAYLOAD).catch(() => undefined));

    expect(ingestionSpan()?.spanContext().traceId).toBe(expected);
  });
});
