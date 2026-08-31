'use client';

import {
  Button,
  Dropdown,
  Field,
  Input,
  Option,
  Text,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useActionState, type ReactElement } from 'react';

import { createStoreAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '720px',
    marginBlock: tokens.spacingVerticalL,
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '220px' },
  note: { color: tokens.colorNeutralForeground3, maxWidth: '62ch' },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
});

const CHUNK_KINDS = [
  { value: 'markdown-heading', label: 'By heading — keeps a section together' },
  { value: 'recursive', label: 'By paragraph — for prose without structure' },
  { value: 'fixed', label: 'Fixed window — for anything else' },
];

export function StoreForm({
  projectId,
  aliases,
}: {
  projectId: string;
  aliases: string[];
}): ReactElement {
  const styles = useStyles();
  const [state, action, pending] = useActionState(createStoreAction, EMPTY);

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="projectId" value={projectId} />
      <Title2>New vector store</Title2>

      <Text as="p" className={styles.note}>
        The embedding model is fixed once the store exists. Changing it later invalidates every
        vector already indexed, so that is a new store rather than an edit.
      </Text>

      {state.error !== undefined && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}

      <div className={styles.row}>
        <Field label="Name" required className={styles.grow}>
          <Input name="name" />
        </Field>
        <Field
          label="Slug"
          required
          className={styles.grow}
          hint="Lowercase, digits and hyphens. Unique per project."
        >
          <Input name="slug" />
        </Field>
      </div>

      <Field label="Description">
        <Input name="description" />
      </Field>

      <div className={styles.row}>
        <Field
          label="Embedding alias"
          required
          className={styles.grow}
          hint={
            aliases.length > 0
              ? 'Its width is discovered when the store is created.'
              : 'No alias in this project advertises embeddings.'
          }
        >
          <Dropdown name="embeddingAlias" defaultValue={aliases[0] ?? 'embedding-default'}>
            {(aliases.length > 0 ? aliases : ['embedding-default']).map((alias) => (
              <Option key={alias} value={alias}>
                {alias}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Chunking" className={styles.grow}>
          <Dropdown name="chunkKind" defaultValue="markdown-heading">
            {CHUNK_KINDS.map((kind) => (
              <Option key={kind.value} value={kind.value} text={kind.label}>
                {kind.label}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </div>

      <div className={styles.row}>
        <Field label="Chunk size (tokens)" hint="64 to 2048.">
          <Input name="maxTokens" type="number" defaultValue="512" />
        </Field>
        <Field label="Overlap (tokens)" hint="Must be smaller than the chunk size.">
          <Input name="overlapTokens" type="number" defaultValue="64" />
        </Field>
      </div>

      <div>
        <Button appearance="primary" type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create store'}
        </Button>
      </div>
    </form>
  );
}
