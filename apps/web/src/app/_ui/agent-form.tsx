'use client';

import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Text,
  Textarea,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useActionState, type ReactElement } from 'react';

import {
  toolChoices,
  type AttachableTool,
  type StoreReference,
  type ToolReference,
} from '../../modules/registry/domain/agent-tools';
import { createAgentAction, saveAgentDraftAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '760px',
    marginBlock: tokens.spacingVerticalL,
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '220px' },
  actions: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    marginBlockStart: tokens.spacingVerticalM,
  },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  tools: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  tool: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS },
  toolText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  toolName: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  toolDescription: { color: tokens.colorNeutralForeground3 },
});

export interface AgentFormValues {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  modelAlias: string;
  temperature: string;
  tools: ToolReference[];
  /** Not edited here yet, but carried back so a save does not detach them. */
  knowledge: StoreReference[];
}

export function AgentForm({
  projectId,
  assetId,
  expectedVersion,
  values,
  aliases,
  attachableTools,
}: {
  projectId: string;
  /** Absent when creating. */
  assetId?: string;
  expectedVersion?: number;
  values: AgentFormValues;
  aliases: string[];
  attachableTools: AttachableTool[];
}): ReactElement {
  const styles = useStyles();
  const creating = assetId === undefined;
  const [state, action, pending] = useActionState(
    creating ? createAgentAction : saveAgentDraftAction,
    EMPTY,
  );
  const choices = toolChoices(attachableTools, values.tools);

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="projectId" value={projectId} />
      {!creating && <input type="hidden" name="assetId" value={assetId} />}
      {expectedVersion !== undefined && (
        <input type="hidden" name="expectedVersion" value={expectedVersion} />
      )}
      <input type="hidden" name="attachedTools" value={JSON.stringify(values.tools)} />
      <input type="hidden" name="knowledge" value={JSON.stringify(values.knowledge)} />

      {creating && <Title2>New agent</Title2>}

      {state.error !== undefined && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}

      {creating && (
        <div className={styles.row}>
          <Field label="Name" required className={styles.grow}>
            <Input name="name" defaultValue={values.name} />
          </Field>
          <Field
            label="Slug"
            required
            className={styles.grow}
            hint="Lowercase, digits and hyphens. Unique per project."
          >
            <Input name="slug" defaultValue={values.slug} />
          </Field>
        </div>
      )}

      {creating && (
        <Field label="Description">
          <Input name="description" defaultValue={values.description} />
        </Field>
      )}

      <Field label="Instructions" required hint="What the agent is for, and how it should answer.">
        <Textarea name="instructions" rows={8} defaultValue={values.instructions} />
      </Field>

      <div className={styles.row}>
        <Field
          label="Model alias"
          required
          className={styles.grow}
          hint={
            aliases.length > 0
              ? `Available here: ${aliases.join(', ')}`
              : 'The project classification decides which aliases may serve it.'
          }
        >
          <Input name="modelAlias" list="agent-aliases" defaultValue={values.modelAlias} />
        </Field>
        <Field label="Temperature" hint="0 to 2. Leave empty for the model default.">
          <Input name="temperature" type="number" step="0.1" defaultValue={values.temperature} />
        </Field>
      </div>

      <datalist id="agent-aliases">
        {aliases.map((alias) => (
          <option key={alias} value={alias} />
        ))}
      </datalist>

      <fieldset className={styles.tools} aria-describedby="agent-tools-hint">
        <legend>
          <Text weight="semibold">Tools</Text>
        </legend>
        <Text id="agent-tools-hint" size={200} className={styles.hint}>
          What the model may call. Built-in tools come with the platform; nothing has to be created
          first. Every call is still rate limited and audited.
        </Text>
        {choices.length === 0 ? (
          <Text size={200} className={styles.hint}>
            No tools can be attached in this project right now.
          </Text>
        ) : (
          choices.map((choice) => (
            <Checkbox
              key={choice.toolId}
              className={styles.tool}
              name="tools"
              value={choice.toolId}
              defaultChecked={choice.attached}
              label={
                <span className={styles.toolText}>
                  <span className={styles.toolName}>
                    <Text weight="semibold">{choice.name}</Text>
                    {choice.source === 'platform' && (
                      <Badge appearance="outline" size="small">
                        built-in
                      </Badge>
                    )}
                    {choice.riskLevel !== undefined && choice.riskLevel !== 'low' && (
                      <Badge appearance="tint" size="small" color="warning">
                        {choice.riskLevel} risk
                      </Badge>
                    )}
                    {!choice.available && (
                      <Badge appearance="tint" size="small" color="danger">
                        not available in this project
                      </Badge>
                    )}
                  </span>
                  {choice.description !== undefined && (
                    <Text size={200} className={styles.toolDescription}>
                      {choice.description}
                    </Text>
                  )}
                </span>
              }
            />
          ))
        )}
      </fieldset>

      <div className={styles.actions}>
        <Button appearance="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : creating ? 'Create agent' : 'Save draft'}
        </Button>
      </div>
    </form>
  );
}
