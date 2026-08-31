'use client';

import {
  Badge,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Beaker24Regular } from '@fluentui/react-icons';
import type { ReactElement } from 'react';

import type {
  EvaluationMetric,
  EvaluationRunSummary,
  EvaluationStatus,
} from '../../modules/observability/application/evaluation-ports';
import type { EvaluationsView } from '../../modules/observability/application/use-cases/inspect-evaluations';

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '78ch' },
  card: { padding: tokens.spacingVerticalL, marginBlockStart: tokens.spacingVerticalL },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    marginBlockEnd: tokens.spacingVerticalM,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  numeric: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
    marginBlockStart: tokens.spacingVerticalL,
  },
  warning: {
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    marginBlockStart: tokens.spacingVerticalL,
  },
});

// `errored` is not a worse `failed`. One is quality below a threshold and the
// prompts are the place to look; the other is a measurement that did not
// happen, and looking at prompts would waste a morning.
const STATUS_TONE: Record<EvaluationStatus, 'success' | 'danger' | 'warning' | 'informative'> = {
  passed: 'success',
  failed: 'danger',
  errored: 'warning',
  running: 'informative',
};

export function EvaluationList({ view }: { view: EvaluationsView }): ReactElement {
  const styles = useStyles();

  return (
    <>
      <div className={styles.header}>
        <Beaker24Regular />
        <Title2>Evaluations</Title2>
      </div>

      <Text as="p" className={styles.lede}>
        Quality measured, not assumed. A suite says what to measure and where the failing threshold
        sits; a run that falls below one stops a merge, and so does a run that did not measure what
        it claimed.
      </Text>

      {view.gated > 0 && (
        <div className={styles.warning} role="status">
          <Text weight="semibold">
            {view.gated} recent run{view.gated === 1 ? '' : 's'} would stop a merge.
          </Text>
        </div>
      )}

      {!view.available ? (
        <div className={styles.empty}>
          <Text>
            No evaluation service is configured. Set <code>EVALUATION_URL</code> to enable this
            screen.
          </Text>
        </div>
      ) : view.runs.length === 0 ? (
        <div className={styles.empty}>
          <Text>
            No runs yet. <code>make eval</code> runs the suites in <code>evals/suites</code>.
          </Text>
        </div>
      ) : (
        view.runs.map((run) => <Run key={run.id} run={run} />)
      )}
    </>
  );
}

function Run({ run }: { run: EvaluationRunSummary }): ReactElement {
  const styles = useStyles();

  return (
    <Card className={styles.card}>
      <div className={styles.head}>
        <Title3>{run.suite}</Title3>
        <Badge appearance="tint" color={STATUS_TONE[run.status]}>
          {run.status}
        </Badge>
        <span className={styles.mono}>{run.alias}</span>
        <span className={styles.mono}>{run.startedAt.slice(0, 19).replace('T', ' ')}</span>
      </div>

      {run.errorCode !== null && (
        <Text as="p">
          It did not measure: <code>{run.errorCode}</code>
        </Text>
      )}

      {run.metrics.length > 0 && (
        <Table aria-label={`Metrics for ${run.suite}`} size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Evaluator</TableHeaderCell>
              <TableHeaderCell>Value</TableHeaderCell>
              <TableHeaderCell>Bound</TableHeaderCell>
              <TableHeaderCell>Cases</TableHeaderCell>
              <TableHeaderCell>Held</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.metrics.map((metric) => (
              <TableRow key={metric.evaluator}>
                <TableCell>{metric.evaluator}</TableCell>
                <TableCell className={styles.numeric}>{format(metric)}</TableCell>
                <TableCell className={styles.mono}>{boundOf(metric)}</TableCell>
                <TableCell className={styles.numeric}>{metric.sampleSize}</TableCell>
                <TableCell>
                  <Badge appearance="tint" color={metric.passed ? 'success' : 'danger'}>
                    {metric.passed ? 'yes' : 'no'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/** A cost is micros and a latency is milliseconds; a score is a fraction. */
function format(metric: EvaluationMetric): string {
  return metric.maximum !== null ? Math.round(metric.value).toString() : metric.value.toFixed(3);
}

function boundOf(metric: EvaluationMetric): string {
  if (metric.maximum !== null) return `<= ${metric.maximum.toString()}`;
  if (metric.threshold !== null) return `>= ${metric.threshold.toString()}`;
  return '—';
}
