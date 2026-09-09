'use client';

import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Radio,
  RadioGroup,
  Text,
  Textarea,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useActionState, useState, type ReactElement } from 'react';

import { annotateTraceAction, type ActionResult } from '../actions';
import type {
  Annotation,
  FailureModeCount,
} from '../../modules/observability/application/evaluation-ports';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  card: { padding: tokens.spacingVerticalL, marginBlockEnd: tokens.spacingVerticalL },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  note: { color: tokens.colorNeutralForeground3, maxWidth: '62ch' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '200px' },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
  existing: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginBlockStart: tokens.spacingVerticalM,
    paddingBlockStart: tokens.spacingVerticalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  entry: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  modes: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
});

/**
 * Where error analysis happens.
 *
 * A trace view that only renders spans tells you where the time went. This is
 * for the other question — was the answer any good, and if not, how was it bad
 * — which nothing in the platform can answer on its own and which is what a
 * failure taxonomy is made of.
 *
 * The taxonomy is offered as a datalist rather than a dropdown: picking an
 * existing mode is one keystroke, and inventing a new one is still possible.
 * A closed list would make the taxonomy whatever it was on the day somebody
 * wrote the enum.
 */
export function TraceAnnotations({
  projectId,
  traceId,
  annotations,
  taxonomy,
  unavailable = false,
}: {
  projectId: string;
  traceId: string;
  annotations: Annotation[];
  taxonomy: FailureModeCount[];
  /** The evaluation service could not be read. Not the same as "none yet". */
  unavailable?: boolean;
}): ReactElement {
  const styles = useStyles();
  const [state, action, pending] = useActionState(annotateTraceAction, EMPTY);
  const [verdict, setVerdict] = useState('bad');

  return (
    <Card className={styles.card}>
      <Title3>What happened here</Title3>

      <Text as="p" className={styles.note}>
        An evaluator written before anybody read a trace measures what its author imagined. This is
        the reading: say whether the answer was good, and if it was not, say how.
      </Text>

      {unavailable && (
        <p className={styles.error} role="status">
          The annotations for this trace could not be read, so this is not &ldquo;nobody has
          annotated it&rdquo;. Recording one now may overwrite an earlier verdict of your own.
        </p>
      )}

      <form action={action} className={styles.form}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="traceId" value={traceId} />
        {state.error !== undefined && (
          <p className={styles.error} role="alert">
            {state.error}
          </p>
        )}

        <Field label="The answer was">
          <RadioGroup
            name="verdict"
            layout="horizontal"
            value={verdict}
            onChange={(_event, data) => {
              setVerdict(data.value);
            }}
          >
            <Radio value="bad" label="Bad" />
            <Radio value="good" label="Good" />
          </RadioGroup>
        </Field>

        {verdict === 'bad' && (
          <Field
            label="What went wrong"
            required
            hint="A few words. The same words as last time, when it is the same failure."
          >
            <Input name="failureMode" list="failure-modes" />
          </Field>
        )}

        <datalist id="failure-modes">
          {taxonomy.map((entry) => (
            <option key={entry.failureMode} value={entry.failureMode} />
          ))}
        </datalist>

        <Field
          label="Which evaluator should have caught it"
          hint="Optional. With the text below, naming one makes this a label a judge is calibrated against."
        >
          <RadioGroup name="evaluator" layout="horizontal">
            <Radio value="" label="None" />
            <Radio value="groundedness" label="Groundedness" />
            <Radio value="relevance" label="Relevance" />
          </RadioGroup>
        </Field>

        <Field label="Note">
          <Textarea name="note" resize="vertical" />
        </Field>

        {/*
          Typed rather than prefilled, and the hint says why: a span carries
          token counts and never prompt content, so the console has no answer
          to put here. Pasting it is what turns a verdict into a label, and
          leaving it empty is the ordinary case rather than a mistake.
        */}
        <details>
          <summary>
            <Text weight="semibold">Make this a label</Text>
          </summary>
          <div className={styles.form}>
            <Text as="p" className={styles.note}>
              Traces record how long a call took and what it cost, never what was said. Paste the
              question and the answer you just graded, and this annotation also becomes a human
              label — which is what ADR-028 calibrates a judge against.
            </Text>
            <Field label="Question">
              <Textarea name="question" resize="vertical" />
            </Field>
            <Field label="Answer">
              <Textarea name="answer" resize="vertical" />
            </Field>
          </div>
        </details>

        <div className={styles.row}>
          <Button type="submit" appearance="primary" disabled={pending}>
            {pending ? 'Recording…' : 'Record'}
          </Button>
        </div>
      </form>

      {taxonomy.length > 0 && (
        <div className={styles.existing}>
          <Text weight="semibold">This project&apos;s failure modes</Text>
          <div className={styles.modes}>
            {taxonomy.map((entry) => (
              <Badge key={entry.failureMode} appearance="tint" color="informative">
                {entry.failureMode} · {entry.count}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {annotations.length > 0 && (
        <div className={styles.existing}>
          <Text weight="semibold">Already recorded</Text>
          {annotations.map((annotation) => (
            <div key={annotation.id} className={styles.entry}>
              <Badge
                appearance="filled"
                color={annotation.verdict === 'good' ? 'success' : 'danger'}
              >
                {annotation.verdict}
              </Badge>
              <Text>{annotation.failureMode ?? '—'}</Text>
              <Text className={styles.note}>{annotation.principalId}</Text>
              {annotation.isLabel && (
                <Badge appearance="outline" color="brand">
                  label
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
