/**
 * Reading a trace.
 *
 * Domain, not infrastructure: it opens nothing and calls nothing. What lives
 * here is the shape of OTLP JSON — which is genuinely fiddly, because an
 * attribute is `{key, value: {stringValue: "..."}}` rather than a pair, and a
 * span's timing arrives as a nanosecond string that overflows a JS number if
 * you treat it as one.
 *
 * Getting that wrong does not throw. It renders a blank cell, and a blank cell
 * in a trace view reads as "the platform did not record it".
 */

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanView {
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  startedAtMs: number;
  durationMs: number;
  status: SpanStatus;
  /** How deep in the tree, once the spans are ordered for display. */
  depth: number;
  attributes: Record<string, string>;
}

export interface TraceSummary {
  traceId: string;
  rootService: string;
  rootName: string;
  startedAtMs: number;
  durationMs: number;
}

/** What a trace says about the model call inside it (`gen_ai.*`). */
export interface ModelRollup {
  provider?: string;
  requestModel?: string;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TraceDetail {
  traceId: string;
  spans: SpanView[];
  /** Framework plumbing left out of `spans`. Counted, never silently dropped. */
  hiddenSpans: number;
  projectId?: string;
  /** The platform's id for the call, which is how its content is found. */
  requestId?: string;
  principalId?: string;
  alias?: string;
  dataZone?: string;
  errorCode?: string;
  model?: ModelRollup;
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/* OTLP JSON, as Tempo returns it                                      */

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key?: string;
  value?: OtlpValue;
}

interface OtlpSpan {
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpAttribute[];
  status?: { code?: number | string; message?: string };
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[];
}

interface OtlpBatch {
  resource?: { attributes?: OtlpAttribute[] };
  scopeSpans?: OtlpScopeSpans[];
  instrumentationLibrarySpans?: OtlpScopeSpans[];
}

export interface OtlpTrace {
  batches?: OtlpBatch[];
}

/**
 * Nanoseconds arrive as a STRING because they do not fit a double.
 *
 * `Number('1756500000000000000')` loses the last few digits, which is fine for
 * a wall-clock instant and fatal for a duration: two spans a microsecond apart
 * come out identical. Milliseconds are computed with BigInt and only then
 * narrowed.
 */
export function nanosToMs(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  try {
    return Number(BigInt(raw) / 1_000_000n);
  } catch {
    return 0;
  }
}

export function attributeValue(value: OtlpValue | undefined): string {
  if (value === undefined) return '';
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  return '';
}

export function attributesOf(raw: OtlpAttribute[] | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const entry of raw ?? []) {
    if (entry.key !== undefined && entry.key !== '') {
      attributes[entry.key] = attributeValue(entry.value);
    }
  }
  return attributes;
}

function statusOf(span: OtlpSpan): SpanStatus {
  // OTLP encodes it as an enum that arrives as a number over gRPC and as its
  // name over JSON, depending on who serialised it.
  const code = span.status?.code;
  if (code === 2 || code === 'STATUS_CODE_ERROR') return 'error';
  if (code === 1 || code === 'STATUS_CODE_OK') return 'ok';
  return 'unset';
}

/** Flattens the batches into spans, each carrying its resource's service name. */
export function toSpans(trace: OtlpTrace): SpanView[] {
  const spans: SpanView[] = [];

  for (const batch of trace.batches ?? []) {
    const resource = attributesOf(batch.resource?.attributes);
    const service = resource['service.name'] ?? 'unknown';
    // Tempo has used both field names across versions; reading only the
    // current one silently returns an empty trace against an older backend.
    const groups = [...(batch.scopeSpans ?? []), ...(batch.instrumentationLibrarySpans ?? [])];

    for (const group of groups) {
      for (const span of group.spans ?? []) {
        const startedAtMs = nanosToMs(span.startTimeUnixNano);
        spans.push({
          spanId: span.spanId ?? '',
          ...(span.parentSpanId !== undefined &&
            span.parentSpanId !== '' && { parentSpanId: span.parentSpanId }),
          service,
          name: span.name ?? '',
          startedAtMs,
          durationMs: Math.max(0, nanosToMs(span.endTimeUnixNano) - startedAtMs),
          status: statusOf(span),
          depth: 0,
          attributes: attributesOf(span.attributes),
        });
      }
    }
  }

  return spans;
}

/**
 * Orders spans as a tree, depth first, so the view reads as a call stack.
 *
 * A span whose parent is not in the trace is treated as a root rather than
 * dropped: a sampled or truncated trace is still worth looking at, and losing
 * the one span that says what went wrong is the wrong trade.
 */
export function orderForDisplay(spans: SpanView[]): SpanView[] {
  const byParent = new Map<string, SpanView[]>();
  const present = new Set(spans.map((span) => span.spanId));

  for (const span of spans) {
    const parent =
      span.parentSpanId !== undefined && present.has(span.parentSpanId) ? span.parentSpanId : '';
    byParent.set(parent, [...(byParent.get(parent) ?? []), span]);
  }

  for (const children of byParent.values()) {
    children.sort((left, right) => left.startedAtMs - right.startedAtMs);
  }

  const ordered: SpanView[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const span of byParent.get(parent) ?? []) {
      ordered.push({ ...span, depth });
      // A cycle would loop forever. Spans come from a backend, and a backend
      // is data: it does not get to hang the console.
      if (depth < 32) walk(span.spanId, depth + 1);
    }
  };
  walk('', 0);

  // Anything unreachable (a cycle) is appended rather than lost.
  const seen = new Set(ordered.map((span) => span.spanId));
  return [...ordered, ...spans.filter((span) => !seen.has(span.spanId))];
}

/**
 * Spans that are the web framework talking to itself.
 *
 * Auto-instrumentation records one span per Express layer, so a request that
 * does a single useful thing arrives as a dozen `middleware - patched` entries
 * of 0 ms with the actual work buried among them.
 *
 * They are separated rather than deleted, and the count is reported: a trace
 * viewer that quietly drops spans is lying about the trace. Suppressing them at
 * the exporter would be better still — it would save recording and storing them
 * — but the console has to read whatever a backend sends, and this is the half
 * that is ours.
 */
const PLUMBING = /^(middleware|router|request handler) - /;

export function isPlumbing(span: SpanView): boolean {
  // Only when it also took no time. A middleware that actually blocked for
  // 400 ms is the most interesting span in the trace, not noise.
  return PLUMBING.test(span.name) && span.durationMs === 0;
}

/**
 * The attribute names this console reads.
 *
 * A THIRD copy of names ADR-009 says live in `@aia/telemetry` — the console
 * does not depend on that package, because a Server Component pulling in the
 * Node SDK would drag an OTel bootstrap into the browser bundle's dependency
 * graph. The copy is the accepted price; getting one wrong is silent, and that
 * is the part worth knowing. `detailOf` returns `undefined` for a name nothing
 * matches, `Pair` renders nothing for an undefined value, and the row simply
 * disappears from the card — which reads as "the platform did not record it".
 * The tests below pin every name for that reason.
 */
const GEN_AI = {
  /**
   * Both names, oldest first.
   *
   * The GenAI conventions renamed `gen_ai.system` to `gen_ai.provider.name`.
   * The router emits both through the transition, and reading both means this
   * console keeps working against a trace recorded before the change and
   * against one recorded by a service that has already dropped the old name.
   */
  provider: ['gen_ai.system', 'gen_ai.provider.name'],
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
} as const;

const AIA = {
  projectId: 'aia.project_id',
  requestId: 'aia.request_id',
  principalId: 'aia.principal_id',
  alias: 'aia.alias',
  dataZone: 'aia.data_zone',
  errorCode: 'aia.error_code',
} as const;

/**
 * Rolls the whole trace up into what somebody actually wants to know.
 *
 * The attributes are read from ANY span, not only the root: the model call is
 * a child span, and `aia.project_id` is annotated wherever a request enters a
 * service. Taking only the root would leave every field blank on a trace that
 * records all of them.
 */
export function detailOf(traceId: string, spans: SpanView[]): TraceDetail {
  const ordered = orderForDisplay(spans);
  const shown = ordered.filter((span) => !isPlumbing(span));
  const model: ModelRollup = {};

  // Read from EVERY span, including the ones not shown: a hidden span still
  // carries attributes, and losing `aia.project_id` because a middleware was
  // filtered out would blank the panel that says whose request this was.
  const first = (key: string | readonly string[]): string | undefined => {
    const keys = typeof key === 'string' ? [key] : key;
    for (const span of ordered) {
      for (const candidate of keys) {
        const value = span.attributes[candidate];
        if (value !== undefined && value !== '') return value;
      }
    }
    return undefined;
  };

  const provider = first(GEN_AI.provider);
  const requestModel = first(GEN_AI.requestModel);
  const responseModel = first(GEN_AI.responseModel);
  const inputTokens = numberOf(first(GEN_AI.inputTokens));
  const outputTokens = numberOf(first(GEN_AI.outputTokens));

  if (provider !== undefined) model.provider = provider;
  if (requestModel !== undefined) model.requestModel = requestModel;
  if (responseModel !== undefined) model.responseModel = responseModel;
  if (inputTokens !== undefined) model.inputTokens = inputTokens;
  if (outputTokens !== undefined) model.outputTokens = outputTokens;

  const projectId = first(AIA.projectId);
  // What links this trace to the record of what was actually said. A trace
  // without it is a call from before the attribute existed, or one that never
  // reached the router -- and the content panel then says so rather than
  // rendering an empty conversation.
  const requestId = first(AIA.requestId);
  const principalId = first(AIA.principalId);
  const alias = first(AIA.alias);
  const dataZone = first(AIA.dataZone);
  const errorCode = first(AIA.errorCode);

  return {
    traceId,
    spans: shown,
    hiddenSpans: ordered.length - shown.length,
    ...(projectId !== undefined && { projectId }),
    ...(requestId !== undefined && { requestId }),
    ...(principalId !== undefined && { principalId }),
    ...(alias !== undefined && { alias }),
    ...(dataZone !== undefined && { dataZone }),
    ...(errorCode !== undefined && { errorCode }),
    ...(Object.keys(model).length > 0 && { model }),
    // Across every span, hidden ones included: the request took as long as it
    // took, whatever the view chooses to draw.
    durationMs: totalDuration(ordered),
  };
}

/**
 * Wall-clock, not the sum of the spans.
 *
 * Adding durations double-counts everything a parent waited on, and a trace
 * with parallel calls comes out longer than the request ever took.
 */
export function totalDuration(spans: SpanView[]): number {
  if (spans.length === 0) return 0;

  const start = Math.min(...spans.map((span) => span.startedAtMs));
  const end = Math.max(...spans.map((span) => span.startedAtMs + span.durationMs));
  return end - start;
}

function numberOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
