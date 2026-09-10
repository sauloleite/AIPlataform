import { Badge, Card, Text, Title3 } from '@fluentui/react-components';
import type { ReactElement } from 'react';

import type { CompletionView } from '../../modules/observability/application/use-cases/inspect-completion';

/**
 * What the call actually said.
 *
 * A server component: the content is read with the server-side token and never
 * reaches the browser as anything but rendered text, which is the same rule the
 * whole console follows for the platform token.
 *
 * Three different silences, told apart on purpose. A trace with no request id
 * predates the attribute or never reached the router. A refused read is usually
 * a viewer without `auditor` — a correct answer, not a fault. A project that
 * does not capture content has nothing to show and nothing wrong with it. Each
 * of those sends somebody somewhere different, and one grey "no content
 * available" would send them all to the same wrong place.
 */
export function TraceContent({ completion }: { completion: CompletionView }): ReactElement {
  const { record, reason } = completion;

  return (
    <Card style={{ padding: '1rem', marginBlockEnd: '1rem' }}>
      <Title3>What was said</Title3>

      {record === null && reason === 'no-request-id' && (
        <Text as="p">
          This trace carries no <code>aia.request_id</code>, so there is no record to look up. Calls
          made before that attribute existed, and anything that never reached the router, look like
          this.
        </Text>
      )}

      {record === null && reason === 'unreadable' && (
        <Text as="p">
          The record could not be read. Reading what a conversation contained needs the{' '}
          <strong>auditor</strong> or <strong>project owner</strong> role, which is a stricter right
          than using the platform.
        </Text>
      )}

      {record !== null && !record.contentCaptured && (
        <Text as="p">
          This project does not capture conversation content, so the record holds the accounting and
          nothing that was said. That is a policy, not a gap: content capture is opt-in per project,
          and everything else on this page still describes the call.
        </Text>
      )}

      {record !== null && record.contentCaptured && (
        <>
          <Text as="p" style={{ color: 'var(--colorNeutralForeground3)' }}>
            Redacted when it was written, never at read time — a record that needed redacting on the
            way out would have been stored unredacted.
            {record.guardrailsUnverified && ' Guardrails were unreachable for this call (ADR-026).'}
          </Text>
          <dl>
            <dt>
              <Text weight="semibold">Prompt</Text>
            </dt>
            <dd style={{ whiteSpace: 'pre-wrap', marginBlockEnd: '1rem' }}>{record.prompt}</dd>
            <dt>
              <Text weight="semibold">Answer</Text>
            </dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{record.completion}</dd>
          </dl>
        </>
      )}

      {record !== null && (
        <p>
          <Badge appearance="tint">{record.alias}</Badge>{' '}
          <Badge appearance="tint" color={record.status === 'completed' ? 'success' : 'danger'}>
            {record.errorCode ?? record.status}
          </Badge>{' '}
          <Badge appearance="tint">
            {record.promptTokens} in / {record.completionTokens} out
          </Badge>
        </p>
      )}
    </Card>
  );
}
