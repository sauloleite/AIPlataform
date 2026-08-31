'use client';

import { Badge, Card, Text, Title2, Title3, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactElement } from 'react';

import type { SpanView, TraceDetail } from '../../modules/observability/domain/trace';

const useStyles = makeStyles({
  header: { marginBlock: tokens.spacingVerticalXL },
  traceId: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)',
    gap: tokens.spacingHorizontalXXL,
    '@media (max-width: 960px)': { gridTemplateColumns: '1fr' },
  },
  card: { padding: tokens.spacingVerticalL, marginBlockEnd: tokens.spacingVerticalL },
  pairs: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    margin: 0,
  },
  term: { color: tokens.colorNeutralForeground3 },
  value: { margin: 0, fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
  span: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 6rem',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalXS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  name: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // The bar is the point of a trace view: where the time actually went.
  barTrack: {
    height: '4px',
    backgroundColor: tokens.colorNeutralBackground5,
    borderRadius: tokens.borderRadiusSmall,
    marginBlockStart: tokens.spacingVerticalXXS,
  },
  bar: { height: '100%', backgroundColor: tokens.colorBrandBackground, borderRadius: 'inherit' },
  barError: { backgroundColor: tokens.colorPaletteRedBackground3 },
  numeric: {
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground3,
  },
  service: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  hidden: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginBlockStart: tokens.spacingVerticalM,
  },
});

export function TraceDetailView({ trace }: { trace: TraceDetail }): ReactElement {
  const styles = useStyles();
  const start = trace.spans.length > 0 ? Math.min(...trace.spans.map((s) => s.startedAtMs)) : 0;
  const total = Math.max(1, trace.durationMs);

  return (
    <>
      <div className={styles.header}>
        <Title2>Trace</Title2>
        <div className={styles.traceId}>{trace.traceId}</div>
      </div>

      <div className={styles.columns}>
        <Card className={styles.card}>
          <Title3>Spans</Title3>
          {trace.spans.map((span) => (
            <Span key={span.spanId} span={span} start={start} total={total} />
          ))}
          {trace.hiddenSpans > 0 && (
            <Text as="p" className={styles.hidden}>
              {trace.hiddenSpans} framework span{trace.hiddenSpans === 1 ? '' : 's'} of 0 ms are not
              shown — Express middleware the auto-instrumentation records. A middleware that
              actually took time is never hidden.
            </Text>
          )}
        </Card>

        <div>
          <Card className={styles.card}>
            <Title3>Request</Title3>
            <dl className={styles.pairs}>
              <Pair term="Duration" value={`${trace.durationMs} ms`} />
              <Pair term="Project" value={trace.projectId} />
              <Pair term="Principal" value={trace.principalId} />
              <Pair term="Alias" value={trace.alias} />
              <Pair term="Data zone" value={trace.dataZone} />
              {trace.errorCode !== undefined && <Pair term="Error" value={trace.errorCode} />}
            </dl>
          </Card>

          {trace.model !== undefined && (
            <Card className={styles.card}>
              <Title3>Model call</Title3>
              <dl className={styles.pairs}>
                <Pair term="Provider" value={trace.model.provider} />
                <Pair term="Requested" value={trace.model.requestModel} />
                <Pair term="Answered by" value={trace.model.responseModel} />
                <Pair term="Input tokens" value={trace.model.inputTokens?.toString()} />
                <Pair term="Output tokens" value={trace.model.outputTokens?.toString()} />
              </dl>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Span({
  span,
  start,
  total,
}: {
  span: SpanView;
  start: number;
  total: number;
}): ReactElement {
  const styles = useStyles();
  const offset = ((span.startedAtMs - start) / total) * 100;
  // A zero-width bar is invisible, and an instant span is still a span.
  const width = Math.max(1, (span.durationMs / total) * 100);

  return (
    <div className={styles.span}>
      <div style={{ minWidth: 0, paddingInlineStart: `${(span.depth * 16).toString()}px` }}>
        <div className={styles.name}>
          <span className={styles.label}>{span.name}</span>
          {span.status === 'error' && (
            <Badge appearance="tint" color="danger" size="small">
              error
            </Badge>
          )}
        </div>
        <div className={styles.service}>{span.service}</div>
        <div className={styles.barTrack}>
          <div
            className={`${styles.bar} ${span.status === 'error' ? styles.barError : ''}`}
            style={{ marginInlineStart: `${offset.toString()}%`, width: `${width.toString()}%` }}
          />
        </div>
      </div>
      <div className={styles.numeric}>{span.durationMs} ms</div>
    </div>
  );
}

function Pair({ term, value }: { term: string; value?: string }): ReactElement | null {
  const styles = useStyles();
  if (value === undefined || value === '') return null;

  return (
    <>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.value}>{value}</dd>
    </>
  );
}
