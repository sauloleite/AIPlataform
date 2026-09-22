'use client';

import {
  Badge,
  Card,
  Divider,
  Text,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ReactElement } from 'react';

import type { AgentDetail } from '../../modules/registry/application/use-cases/inspect-agent';
import {
  playgroundContext,
  toolChoices,
  type AttachableTool,
} from '../../modules/registry/domain/agent-tools';
import { AgentForm, type AgentFormValues } from './agent-form';
import { AgentPlayground } from './agent-playground';
import { PublishButton } from './publish-button';
import { STATUS_TONE } from './status';

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
    flexWrap: 'wrap',
  },
  slug: { color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace },
  // Setup beside the playground: the agent is configured and exercised on the
  // same screen, so a change can be tried without navigating away from it.
  columns: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(360px, 1fr)',
    gap: tokens.spacingHorizontalXXL,
    '@media (max-width: 900px)': { gridTemplateColumns: '1fr' },
  },
  side: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: { padding: tokens.spacingVerticalL },
  pairs: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    margin: 0,
  },
  term: { color: tokens.colorNeutralForeground3 },
  value: { margin: 0 },
  readOnly: { color: tokens.colorNeutralForeground2 },
});

export function AgentWorkbench({
  projectId,
  agent,
  aliases,
  attachableTools,
  mayEdit,
}: {
  projectId: string;
  agent: AgentDetail;
  aliases: string[];
  attachableTools: AttachableTool[];
  mayEdit: boolean;
}): ReactElement {
  const styles = useStyles();
  const draft = agent.draft;
  const values = formValuesFrom(agent);
  const liveDefinition = agent.live?.definition;
  const context =
    agent.live !== undefined && liveDefinition?.kind === 'agent'
      ? playgroundContext({
          liveVersion: agent.live.version,
          liveToolNames: toolChoices(attachableTools, liveDefinition.tools)
            .filter((choice) => choice.attached)
            .map((choice) => choice.name),
          hasUnpublishedChanges: agent.hasUnpublishedChanges,
        })
      : undefined;

  return (
    <>
      <div className={styles.header}>
        <Title2>{agent.name}</Title2>
        <span className={styles.slug}>{agent.slug}</span>
        <Badge appearance="tint" color={STATUS_TONE[agent.statusLabel]}>
          {agent.statusLabel}
        </Badge>
      </div>

      <div className={styles.columns}>
        <div>
          <Title3>Setup</Title3>
          {values === undefined ? (
            <Text as="p" className={styles.readOnly}>
              This agent has no definition to show.
            </Text>
          ) : mayEdit ? (
            <AgentForm
              projectId={projectId}
              assetId={agent.id}
              {...(draft !== undefined && { expectedVersion: draft.revision })}
              values={values}
              aliases={aliases}
              attachableTools={attachableTools}
            />
          ) : (
            <ReadOnlySetup
              values={values}
              tools={toolChoices(attachableTools, values.tools)
                .filter((choice) => choice.attached)
                .map((choice) => choice.name)}
            />
          )}
        </div>

        <div className={styles.side}>
          <AgentPlayground
            projectId={projectId}
            agentId={agent.id}
            publishable={agent.live !== undefined}
            {...(context !== undefined && { context })}
          />

          <Card className={styles.card}>
            <Title3>Live version</Title3>
            {agent.live === undefined ? (
              <Text as="p" className={styles.readOnly}>
                Nothing published yet. A run would fail with <code>asset_not_published</code> rather
                than execute a draft.
              </Text>
            ) : (
              <dl className={styles.pairs}>
                <dt className={styles.term}>Version</dt>
                <dd className={styles.value}>{agent.live.version}</dd>
                <dt className={styles.term}>Published</dt>
                <dd className={styles.value}>{agent.live.publishedAt?.slice(0, 10) ?? '—'}</dd>
              </dl>
            )}
            <Divider style={{ marginBlock: tokens.spacingVerticalM }} />
            {mayEdit && <PublishButton projectId={projectId} assetId={agent.id} />}
          </Card>

          <Card className={styles.card}>
            <Title3>Versions</Title3>
            <dl className={styles.pairs}>
              {agent.versions.map((version) => (
                <div key={version.version} style={{ display: 'contents' }}>
                  <dt className={styles.term}>v{version.version}</dt>
                  <dd className={styles.value}>{version.status}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * What the setup pane shows.
 *
 * The draft when one is open, otherwise the published version: the registry
 * opens a draft on the first edit, so between publishing and editing there is
 * nothing but the live definition to show -- and it still has to be editable.
 */
function formValuesFrom(agent: AgentDetail): AgentFormValues | undefined {
  const definition = agent.draft?.definition ?? agent.live?.definition;
  if (definition?.kind !== 'agent') return undefined;

  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description ?? '',
    instructions: definition.instructions,
    modelAlias: definition.modelAlias,
    temperature: definition.temperature?.toString() ?? '',
    tools: definition.tools,
    knowledge: definition.knowledge,
  };
}

function ReadOnlySetup({
  values,
  tools,
}: {
  values: { instructions: string; modelAlias: string };
  tools: string[];
}): ReactElement {
  const styles = useStyles();
  return (
    <dl className={styles.pairs}>
      <dt className={styles.term}>Model</dt>
      <dd className={styles.value}>{values.modelAlias}</dd>
      <dt className={styles.term}>Instructions</dt>
      <dd className={styles.value}>{values.instructions}</dd>
      <dt className={styles.term}>Tools</dt>
      <dd className={styles.value}>{tools.length === 0 ? 'None' : tools.join(', ')}</dd>
    </dl>
  );
}
