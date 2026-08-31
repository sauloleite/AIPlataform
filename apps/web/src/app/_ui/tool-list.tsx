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
import { Toolbox24Regular } from '@fluentui/react-icons';
import { useActionState, type ReactElement } from 'react';

import type { ToolCard } from '../../modules/tools/application/use-cases/inspect-tools';
import { unbindToolAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '72ch' },
  tableWrap: { overflowX: 'auto' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    marginBlockEnd: tokens.spacingVerticalM,
  },
});

const RISK_TONE = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
} as const;

export function ToolList({
  projectId,
  tools,
  mayAdminister,
  failure,
}: {
  projectId: string;
  tools: ToolCard[];
  mayAdminister: boolean;
  failure?: string;
}): ReactElement {
  const styles = useStyles();

  return (
    <>
      <div className={styles.header}>
        <Toolbox24Regular />
        <Title2>Tools</Title2>
      </div>

      <Text as="p" className={styles.lede}>
        The tools this project may invoke. A tool published in the registry does nothing until it is
        allowed here, and every call is rate limited and audited with the identity that made it. A
        high-risk tool never runs without a human approving that specific call.
      </Text>

      {failure !== undefined && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      {tools.length === 0 ? (
        <p className={styles.empty}>
          No tools are allowed in this project yet. Publish a tool in the registry, then bind it
          here.
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Tools" size="medium">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Risk</TableHeaderCell>
                <TableHeaderCell>Approval</TableHeaderCell>
                <TableHeaderCell>Rate</TableHeaderCell>
                {mayAdminister && <TableHeaderCell>{''}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((tool) => (
                <TableRow key={tool.toolId}>
                  <TableCell>{tool.name}</TableCell>
                  <TableCell>
                    <span className={styles.mono}>{tool.toolType}</span>
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={RISK_TONE[tool.riskLevel]}>
                      {tool.riskLevel}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {tool.requiresApproval ? (
                      <Badge appearance="tint" color="warning">
                        required
                      </Badge>
                    ) : (
                      <Text size={200}>—</Text>
                    )}
                  </TableCell>
                  <TableCell>
                    {tool.rateLimitPerMinute === null ? '—' : `${tool.rateLimitPerMinute}/min`}
                  </TableCell>
                  {mayAdminister && (
                    <TableCell>
                      <UnbindButton projectId={projectId} toolId={tool.toolId} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

function UnbindButton({ projectId, toolId }: { projectId: string; toolId: string }): ReactElement {
  const [state, action, pending] = useActionState(unbindToolAction, EMPTY);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="toolId" value={toolId} />
      <Button size="small" appearance="subtle" type="submit" disabled={pending}>
        {pending ? 'Withdrawing…' : 'Withdraw'}
      </Button>
      {state.error !== undefined && (
        <Text size={100} role="alert">
          {state.error}
        </Text>
      )}
    </form>
  );
}
