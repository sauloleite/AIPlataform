'use client';

import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { Rocket24Regular } from '@fluentui/react-icons';
import { useActionState, type ReactElement } from 'react';

import { publishAgentAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    maxWidth: '48ch',
  },
});

export function PublishButton({
  projectId,
  assetId,
}: {
  projectId: string;
  assetId: string;
}): ReactElement {
  const styles = useStyles();
  const [state, action, pending] = useActionState(publishAgentAction, EMPTY);

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="assetId" value={assetId} />
      <Button appearance="primary" icon={<Rocket24Regular />} type="submit" disabled={pending}>
        {pending ? 'Publishing…' : 'Publish'}
      </Button>
      {/* Publishing resolves every reference the definition makes, so an
          unresolved tool or store surfaces HERE rather than inside a run. */}
      {state.error !== undefined && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
