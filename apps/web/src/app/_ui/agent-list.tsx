'use client';

import {
  Badge,
  Button,
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
import { Add24Regular, Bot24Regular } from '@fluentui/react-icons';
import type { ReactElement } from 'react';

import type { AgentCard } from '../../modules/registry/application/use-cases/list-agents';
import { STATUS_TONE } from './status';

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  spacer: { flex: 1 },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '70ch' },
  // Wide content scrolls inside its own box; the page body never does.
  tableWrap: { overflowX: 'auto' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  link: { color: tokens.colorBrandForeground1, textDecoration: 'none', fontWeight: 600 },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    marginBlockEnd: tokens.spacingVerticalM,
  },
});

export function AgentList({
  projectId,
  agents,
  mayEdit,
  failure,
}: {
  projectId: string;
  agents: AgentCard[];
  mayEdit: boolean;
  failure?: string;
}): ReactElement {
  const styles = useStyles();
  const base = `/projects/${encodeURIComponent(projectId)}/agents`;

  return (
    <>
      <div className={styles.header}>
        <Bot24Regular />
        <Title2>Agents</Title2>
        <div className={styles.spacer} />
        {mayEdit && (
          <Button appearance="primary" icon={<Add24Regular />} as="a" href={`${base}/new`}>
            New agent
          </Button>
        )}
      </div>

      <Text as="p" className={styles.lede}>
        An agent is a model, its instructions, and the tools and knowledge it may use. It is edited
        as a draft and published as a version; a run always executes a published version, so editing
        never changes a run already in flight.
      </Text>

      {failure !== undefined && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      {agents.length === 0 ? (
        <p className={styles.empty}>No agents yet.{mayEdit ? ' Create one to get started.' : ''}</p>
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Agents" size="medium">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Live version</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <a className={styles.link} href={`${base}/${encodeURIComponent(agent.id)}`}>
                      {agent.name}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Text font="monospace" size={200}>
                      {agent.slug}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={STATUS_TONE[agent.statusLabel]}>
                      {agent.statusLabel}
                    </Badge>
                  </TableCell>
                  <TableCell>{agent.publishedVersion ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
