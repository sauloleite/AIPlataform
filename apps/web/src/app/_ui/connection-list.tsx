'use client';

import {
  Badge,
  Button,
  Card,
  Dropdown,
  Field,
  Input,
  Option,
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
import { PlugConnected24Regular } from '@fluentui/react-icons';
import { useActionState, useState, type ReactElement } from 'react';

import type { ConnectionsView } from '../../modules/tools/application/use-cases/inspect-connections';
import { createConnectionAction, deleteConnectionAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '78ch' },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)',
    gap: tokens.spacingHorizontalXXL,
    '@media (max-width: 960px)': { gridTemplateColumns: '1fr' },
  },
  card: { padding: tokens.spacingVerticalL },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  tableWrap: { overflowX: 'auto' },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    marginBlockEnd: tokens.spacingVerticalM,
  },
  warning: {
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    marginBlockEnd: tokens.spacingVerticalL,
  },
});

const KINDS = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api_key', label: 'API key header' },
  { value: 'basic', label: 'Basic (user:password)' },
  { value: 'none', label: 'No credential' },
] as const;

export function ConnectionList({
  projectId,
  view,
  mayAdminister,
}: {
  projectId: string;
  view: ConnectionsView;
  mayAdminister: boolean;
}): ReactElement {
  const styles = useStyles();
  const [createState, create, creating] = useActionState(createConnectionAction, EMPTY);
  const [removeState, remove] = useActionState(deleteConnectionAction, EMPTY);
  const [kind, setKind] = useState<string>('bearer');

  return (
    <>
      <div className={styles.header}>
        <PlugConnected24Regular />
        <Title2>Connections</Title2>
      </div>

      <Text as="p" className={styles.lede}>
        A credential for an endpoint the platform does not own. What is stored here is the{' '}
        <strong>name</strong> of a secret, never its value: whoever operates the platform puts it in
        a file under <code>/run/secrets</code> or in an <code>AIA_SECRET_*</code> variable, and the
        platform looks it up at the moment of the call.
      </Text>

      {view.unresolved > 0 && (
        <div className={styles.warning} role="status">
          <Text weight="semibold">
            {view.unresolved === 1
              ? '1 connection names a secret this host does not have.'
              : `${view.unresolved.toString()} connections name a secret this host does not have.`}
          </Text>{' '}
          <Text>Any tool using one will fail at its next call.</Text>
        </div>
      )}

      {(createState.error ?? removeState.error) !== undefined && (
        <p className={styles.error} role="alert">
          {createState.error ?? removeState.error}
        </p>
      )}

      <div className={styles.columns}>
        <div>
          {view.connections.length === 0 ? (
            <div className={styles.empty}>
              <Text>No connections yet. A tool on an external endpoint needs one.</Text>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <Table aria-label="Connections" size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Presented as</TableHeaderCell>
                    <TableHeaderCell>Secret</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    {mayAdminister && <TableHeaderCell />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.connections.map((connection) => (
                    <TableRow key={connection.id}>
                      <TableCell>
                        <div>
                          <Text weight="semibold">{connection.name}</Text>
                          <br />
                          <span className={styles.mono}>{connection.slug}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={styles.mono}>
                          {connection.kind === 'none' ? '—' : connection.header}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={styles.mono}>{connection.secretRef || '—'}</span>
                      </TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={connection.resolved ? 'success' : 'danger'}>
                          {connection.resolved ? 'resolved' : 'missing'}
                        </Badge>
                      </TableCell>
                      {mayAdminister && (
                        <TableCell>
                          <form action={remove}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="connectionId" value={connection.id} />
                            <Button appearance="subtle" size="small" type="submit">
                              Remove
                            </Button>
                          </form>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {mayAdminister && (
          <Card className={styles.card}>
            <Title3>New connection</Title3>
            <form action={create} className={styles.form}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="kind" value={kind} />

              <Field label="Name" required>
                <Input name="name" placeholder="GitLab" />
              </Field>
              <Field label="Slug" required hint="Lowercase, digits and dashes.">
                <Input name="slug" placeholder="gitlab" />
              </Field>
              <Field label="Kind">
                <Dropdown
                  value={KINDS.find((option) => option.value === kind)?.label ?? ''}
                  selectedOptions={[kind]}
                  onOptionSelect={(_event, data) => {
                    setKind(data.optionValue ?? 'bearer');
                  }}
                >
                  {KINDS.map((option) => (
                    <Option key={option.value} value={option.value}>
                      {option.label}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              {kind === 'api_key' && (
                <Field label="Header" hint="Where the key goes. Authorization by default.">
                  <Input name="header" placeholder="X-Api-Key" />
                </Field>
              )}
              {kind !== 'none' && (
                <Field
                  label="Secret name"
                  required
                  hint="The NAME of the secret, not the secret. A file under /run/secrets, or AIA_SECRET_<NAME>."
                >
                  <Input name="secretRef" placeholder="gitlab-token" />
                </Field>
              )}
              <Button appearance="primary" type="submit" disabled={creating}>
                Create
              </Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
