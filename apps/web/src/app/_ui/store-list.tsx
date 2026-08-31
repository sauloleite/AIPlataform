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
import { Add24Regular, Library24Regular, Share24Regular } from '@fluentui/react-icons';
import { useActionState, type ReactElement } from 'react';

import type { StoreSummary } from '../../modules/knowledge/application/ports';
import { subscribeToStoreAction, unsubscribeFromStoreAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
  },
  spacer: { flex: 1 },
  lede: { color: tokens.colorNeutralForeground2, maxWidth: '70ch' },
  tableWrap: { overflowX: 'auto' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  link: { color: tokens.colorBrandForeground1, textDecoration: 'none', fontWeight: 600 },
  section: { marginBlockStart: tokens.spacingVerticalXXL },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBlockEnd: tokens.spacingVerticalS,
  },
  inline: { display: 'inline' },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    marginBlockEnd: tokens.spacingVerticalM,
  },
});

export function StoreList({
  projectId,
  stores,
  catalogue,
  mayEdit,
  failure,
}: {
  projectId: string;
  stores: StoreSummary[];
  catalogue: StoreSummary[];
  mayEdit: boolean;
  failure?: string;
}): ReactElement {
  const styles = useStyles();
  const base = `/projects/${encodeURIComponent(projectId)}/vector-stores`;

  return (
    <>
      <div className={styles.header}>
        <Library24Regular />
        <Title2>Vector stores</Title2>
        <div className={styles.spacer} />
        {mayEdit && (
          <Button appearance="primary" icon={<Add24Regular />} as="a" href={`${base}/new`}>
            New store
          </Button>
        )}
      </div>

      <Text as="p" className={styles.lede}>
        A store holds documents cut into chunks and indexed for search. The embedding model and its
        width are fixed when the store is created: changing the model invalidates every vector
        already written, so that is a new store rather than an edit.
      </Text>

      {failure !== undefined && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      {stores.length === 0 ? (
        <p className={styles.empty}>
          No vector stores yet.{mayEdit ? ' Create one to start indexing documents.' : ''}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label="Vector stores" size="medium">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Embedding</TableHeaderCell>
                <TableHeaderCell>Chunking</TableHeaderCell>
                <TableHeaderCell>Documents</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((store) => (
                <TableRow key={store.id}>
                  <TableCell>
                    <a className={styles.link} href={`${base}/${encodeURIComponent(store.id)}`}>
                      {store.name}
                    </a>
                  </TableCell>
                  <TableCell>
                    {store.access === 'shared' ? (
                      <Badge appearance="tint" color="informative">
                        shared
                      </Badge>
                    ) : store.visibility === 'public' ? (
                      <Badge appearance="tint" color="success">
                        published
                      </Badge>
                    ) : (
                      <Badge appearance="tint" color="subtle">
                        this project
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={styles.mono}>
                      {store.embeddingAlias} · {store.dimensions}d
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={styles.mono}>
                      {store.chunking.kind} · {store.chunking.maxTokens}
                    </span>
                  </TableCell>
                  <TableCell>{store.documentCount}</TableCell>
                  <TableCell>
                    {store.access === 'shared' && mayEdit && (
                      <SubscriptionButton projectId={projectId} storeId={store.id} subscribed />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <Share24Regular />
          <Title2>Shared by other projects</Title2>
        </div>
        <Text as="p" className={styles.lede}>
          A store its owner published, which this project may reuse instead of building the same
          knowledge base again. Adding one gives read access to its public documents only, and the
          embedding alias has to resolve the same way here -- a project on a stricter data
          classification will be told it cannot.
        </Text>

        {catalogue.length === 0 ? (
          <p className={styles.empty}>Nothing published yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <Table aria-label="Shared stores" size="medium">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Embedding</TableHeaderCell>
                  <TableHeaderCell>Documents</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogue.map((store) => (
                  <TableRow key={store.id}>
                    <TableCell>
                      {store.name}
                      <br />
                      <span className={styles.mono}>owner {store.ownerProjectId.slice(0, 8)}</span>
                    </TableCell>
                    <TableCell>
                      <span className={styles.mono}>
                        {store.embeddingAlias} · {store.dimensions}d
                      </span>
                    </TableCell>
                    <TableCell>{store.documentCount}</TableCell>
                    <TableCell>
                      {mayEdit && (
                        <SubscriptionButton
                          projectId={projectId}
                          storeId={store.id}
                          subscribed={store.subscribed === true}
                        />
                      )}
                    </TableCell>
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

/**
 * Add or remove one shared store.
 *
 * Two forms rather than one with a hidden verb: a failed add and a failed
 * remove are different messages, and sharing one action state would show the
 * wrong one against the wrong button.
 */
function SubscriptionButton({
  projectId,
  storeId,
  subscribed,
}: {
  projectId: string;
  storeId: string;
  subscribed: boolean;
}): ReactElement {
  const styles = useStyles();
  const [state, action, pending] = useActionState(
    subscribed ? unsubscribeFromStoreAction : subscribeToStoreAction,
    EMPTY,
  );

  return (
    <form action={action} className={styles.inline}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="storeId" value={storeId} />
      <Button type="submit" size="small" disabled={pending}>
        {subscribed ? 'Remove' : 'Add to this project'}
      </Button>
      {state.error !== undefined && (
        <Text as="p" className={styles.error} role="alert">
          {state.error}
        </Text>
      )}
    </form>
  );
}
