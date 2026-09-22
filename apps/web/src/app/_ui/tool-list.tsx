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
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Toolbox24Regular } from '@fluentui/react-icons';
import { useActionState, type ReactElement } from 'react';

import type { BuiltinTool } from '../../modules/tools/application/ports';
import type { ToolCard } from '../../modules/tools/application/use-cases/inspect-tools';
import { bindToolAction, unbindToolAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '72ch' },
  section: { marginBlockStart: tokens.spacingVerticalXXL },
  sectionLede: {
    color: tokens.colorNeutralForeground2,
    maxWidth: '72ch',
    marginBlock: tokens.spacingVerticalS,
  },
  tableWrap: { overflowX: 'auto' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  toolName: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  description: { color: tokens.colorNeutralForeground3, maxWidth: '52ch' },
  reason: { color: tokens.colorNeutralForeground3, display: 'block', maxWidth: '40ch' },
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
  builtins,
  projectTools,
  mayAdminister,
  failure,
}: {
  projectId: string;
  builtins: BuiltinTool[];
  projectTools: ToolCard[];
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
        The tools this project may invoke. Every call is rate limited and audited with the identity
        that made it, and a high-risk tool never runs without a human approving that specific call.
      </Text>

      {failure !== undefined && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      <section className={styles.section} aria-labelledby="builtin-tools">
        <Title3 id="builtin-tools">Built-in tools</Title3>
        <Text as="p" className={styles.sectionLede}>
          Provided by the platform in every project, ready to attach to an agent without creating
          anything. A tool that sends data outside the platform is unavailable in a confidential or
          restricted project.
        </Text>
        {builtins.length === 0 ? (
          <p className={styles.empty}>The built-in tools could not be listed.</p>
        ) : (
          <div className={styles.tableWrap}>
            <Table aria-label="Built-in tools" size="medium">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Data</TableHeaderCell>
                  <TableHeaderCell>Risk</TableHeaderCell>
                  <TableHeaderCell>Rate</TableHeaderCell>
                  {mayAdminister && <TableHeaderCell>{''}</TableHeaderCell>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {builtins.map((tool) => (
                  <TableRow key={tool.toolId}>
                    <TableCell>
                      <span className={styles.toolName}>
                        <Text weight="semibold">{tool.name}</Text>
                        <Text size={200} className={styles.description}>
                          {tool.description}
                        </Text>
                      </span>
                    </TableCell>
                    <TableCell>
                      <BuiltinStatus tool={tool} />
                    </TableCell>
                    <TableCell>
                      <Text size={200}>
                        {tool.dataZone === 'global' ? 'Leaves the platform' : 'Stays inside'}
                      </Text>
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={RISK_TONE[tool.riskLevel]}>
                        {tool.riskLevel}
                      </Badge>
                    </TableCell>
                    <TableCell>{`${tool.rateLimitPerMinute}/min`}</TableCell>
                    {mayAdminister && (
                      <TableCell>
                        <SwitchButton projectId={projectId} tool={tool} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="project-tools">
        <Title3 id="project-tools">Project tools</Title3>
        <Text as="p" className={styles.sectionLede}>
          Tools published in the registry for this project. One does nothing until it is allowed
          here.
        </Text>
        {projectTools.length === 0 ? (
          <p className={styles.empty}>
            No project tools are allowed yet. The built-in tools above need none of this.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <Table aria-label="Project tools" size="medium">
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
                {projectTools.map((tool) => (
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
      </section>
    </>
  );
}

function BuiltinStatus({ tool }: { tool: BuiltinTool }): ReactElement {
  const styles = useStyles();

  // Switched off is the project's own decision, and says so first: a tool
  // that is also unconfigured would still not run once switched back on, and
  // the reason below says why.
  if (!tool.enabled) {
    return (
      <Badge appearance="tint" color="subtle">
        switched off
      </Badge>
    );
  }
  if (!tool.available) {
    return (
      <>
        <Badge appearance="tint" color="warning">
          unavailable
        </Badge>
        {tool.unavailableReason !== null && (
          <Text size={200} className={styles.reason}>
            {tool.unavailableReason}
          </Text>
        )}
      </>
    );
  }
  return (
    <Badge appearance="tint" color="success">
      ready
    </Badge>
  );
}

function SwitchButton({ projectId, tool }: { projectId: string; tool: BuiltinTool }): ReactElement {
  const [state, action, pending] = useActionState(bindToolAction, EMPTY);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="toolId" value={tool.toolId} />
      {/* A binding is how a project switches a built-in off; `enabled: true`
          switches it back on without touching anything else. */}
      <input type="hidden" name="enabled" value={tool.enabled ? 'false' : 'true'} />
      <Button size="small" appearance="subtle" type="submit" disabled={pending}>
        {pending ? 'Saving…' : tool.enabled ? 'Switch off' : 'Switch on'}
      </Button>
      {state.error !== undefined && (
        <Text size={100} role="alert">
          {state.error}
        </Text>
      )}
    </form>
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
