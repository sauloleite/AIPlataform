'use client';

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Pulse24Regular } from '@fluentui/react-icons';
import type { ReactElement } from 'react';

import type { TraceListView } from '../../modules/observability/application/use-cases/inspect-traces';

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '78ch' },
  tableWrap: { overflowX: 'auto', marginBlockStart: tokens.spacingVerticalL },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  link: { color: tokens.colorBrandForegroundLink, textDecoration: 'none' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
    marginBlockStart: tokens.spacingVerticalL,
  },
  numeric: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
});

export function TraceList({
  projectId,
  view,
}: {
  projectId: string;
  view: TraceListView;
}): ReactElement {
  const styles = useStyles();

  return (
    <>
      <div className={styles.header}>
        <Pulse24Regular />
        <Title2>Traces</Title2>
      </div>

      <Text as="p" className={styles.lede}>
        Every span the platform records carries <code>aia.project_id</code>, and a model call
        carries the <code>gen_ai.*</code> attributes. This list is filtered inside the tracing
        backend, not after the fact.
      </Text>

      {!view.available ? (
        <div className={styles.empty}>
          <Text>
            No tracing backend is configured. Set <code>TEMPO_URL</code> to enable this screen.
          </Text>
        </div>
      ) : view.traces.length === 0 ? (
        <div className={styles.empty}>
          <Text>No traces in the last hour. Send a request and it will show up here.</Text>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Traces" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Trace</TableHeaderCell>
                <TableHeaderCell>Service</TableHeaderCell>
                <TableHeaderCell>Operation</TableHeaderCell>
                <TableHeaderCell>Started</TableHeaderCell>
                <TableHeaderCell>Duration</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.traces.map((trace) => (
                <TableRow key={trace.traceId}>
                  <TableCell>
                    <a
                      className={`${styles.link} ${styles.mono}`}
                      href={`/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(trace.traceId)}`}
                    >
                      {trace.traceId.slice(0, 16)}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint">{trace.rootService}</Badge>
                  </TableCell>
                  <TableCell>{trace.rootName}</TableCell>
                  <TableCell className={styles.mono}>{clockOf(trace.startedAtMs)}</TableCell>
                  <TableCell className={styles.numeric}>{trace.durationMs} ms</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

function clockOf(startedAtMs: number): string {
  if (startedAtMs === 0) return '—';
  return new Date(startedAtMs).toISOString().slice(11, 19);
}
