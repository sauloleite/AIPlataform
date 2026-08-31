'use client';

import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Spinner,
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
import { Search24Regular } from '@fluentui/react-icons';
import { useActionState, type ReactElement } from 'react';

import type { DocumentSummary } from '../../modules/knowledge/application/ports';
import type { StoreDetail } from '../../modules/knowledge/application/use-cases/inspect-store';
import {
  searchStoreAction,
  setStoreVisibilityAction,
  uploadDocumentAction,
  type ActionResult,
  type SearchResult,
} from '../actions';

const EMPTY: ActionResult = {};
const EMPTY_SEARCH: SearchResult = {};

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalXL,
    flexWrap: 'wrap',
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)',
    gap: tokens.spacingHorizontalXXL,
    '@media (max-width: 980px)': { gridTemplateColumns: '1fr' },
  },
  card: { padding: tokens.spacingVerticalL },
  side: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  tableWrap: { overflowX: 'auto' },
  empty: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  hit: {
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    paddingInlineStart: tokens.spacingHorizontalM,
    marginBlockEnd: tokens.spacingVerticalM,
  },
  hitText: { whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground2 },
});

const TONE: Record<DocumentSummary['status'], 'success' | 'danger' | 'informative'> = {
  ingested: 'success',
  failed: 'danger',
  pending: 'informative',
  parsing: 'informative',
  chunking: 'informative',
  embedding: 'informative',
  indexing: 'informative',
};

export function StoreWorkbench({
  projectId,
  store,
  mayEdit,
}: {
  projectId: string;
  store: StoreDetail;
  mayEdit: boolean;
}): ReactElement {
  const styles = useStyles();
  const [upload, uploadAction, uploading] = useActionState(uploadDocumentAction, EMPTY);
  const [search, searchAction, searching] = useActionState(searchStoreAction, EMPTY_SEARCH);

  return (
    <>
      <div className={styles.header}>
        <Title2>{store.name}</Title2>
        <span className={styles.mono}>
          {store.slug} · {store.embeddingModel} · {store.dimensions}d
        </span>
        <StoreBadges store={store} />
      </div>

      {/* Only the owner may publish; a subscriber has nothing to offer. */}
      {mayEdit && store.access !== 'shared' && (
        <ShareControl projectId={projectId} storeId={store.id} visibility={store.visibility} />
      )}

      <div className={styles.columns}>
        <div>
          <Title3>Documents</Title3>
          {mayEdit && (
            <form action={uploadAction} className={styles.form}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="storeId" value={store.id} />
              <Field
                label="Add a document"
                hint="Text and Markdown parse here. Other formats need aia-document-processing."
              >
                <input type="file" name="file" />
              </Field>
              {upload.error !== undefined && (
                <p className={styles.error} role="alert">
                  {upload.error}
                </p>
              )}
              <div>
                <Button appearance="primary" type="submit" disabled={uploading}>
                  {uploading ? 'Uploading…' : 'Upload'}
                </Button>
              </div>
            </form>
          )}

          {store.documents.length === 0 ? (
            <p className={styles.empty}>Nothing indexed yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <Table aria-label="Documents" size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Title</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Chunks</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {store.documents.map((document) => (
                    <TableRow key={document.id}>
                      <TableCell>{document.title}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={TONE[document.status]}>
                          {/* The error code is the useful half of a failure. */}
                          {document.status === 'failed'
                            ? (document.errorCode ?? 'failed')
                            : document.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{document.chunkCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className={styles.side}>
          <Card className={styles.card}>
            <Title3>Test retrieval</Title3>
            <Text as="p" size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              Searches as you, trimmed to what you may read.
            </Text>
            <form action={searchAction} className={styles.form}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="storeId" value={store.id} />
              <Field>
                <Input
                  name="query"
                  placeholder="Ask a question"
                  defaultValue={search.query ?? ''}
                  contentBefore={<Search24Regular />}
                />
              </Field>
              <Button type="submit" disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </form>

            {searching && <Spinner size="tiny" />}
            {search.error !== undefined && (
              <p className={styles.error} role="alert">
                {search.error}
              </p>
            )}
            {search.hits?.length === 0 && <Text size={200}>Nothing matched.</Text>}
            {search.hits?.map((hit) => (
              <div key={`${hit.documentId}-${hit.chunkIndex}`} className={styles.hit}>
                <Text size={200} weight="semibold">
                  {hit.documentTitle}
                  {'  '}
                  {/* The cosine when there is one. In hybrid mode `score` is a
                      fused rank value, which means nothing on its own. */}
                  <span className={styles.mono}>
                    {hit.vectorScore !== undefined ? hit.vectorScore.toFixed(3) : '—'}
                  </span>{' '}
                  <Badge
                    appearance="tint"
                    size="small"
                    color={hit.retrieval === 'both' ? 'success' : 'subtle'}
                  >
                    {hit.retrieval === 'both'
                      ? 'both'
                      : hit.retrieval === 'text'
                        ? 'exact'
                        : 'similar'}
                  </Badge>
                </Text>
                <Text as="p" size={200} className={styles.hitText}>
                  {hit.text.slice(0, 320)}
                </Text>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Publishing a store, or taking it back (ADR-023).
 *
 * Its own component because the two states say genuinely different things and
 * the wording is the useful part: withdrawing is not the opposite of a
 * checkbox, it revokes every project that had added the store.
 */
function ShareControl({
  projectId,
  storeId,
  visibility,
}: {
  projectId: string;
  storeId: string;
  visibility: 'private' | 'public';
}): ReactElement {
  const styles = useStyles();
  const [state, action, pending] = useActionState(setStoreVisibilityAction, EMPTY);
  const published = visibility === 'public';

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="visibility" value={published ? 'private' : 'public'} />
      <Text as="p" size={200}>
        {published
          ? 'Other projects can find this store and add it. Withdrawing removes it from every project that did.'
          : 'Publishing lists this store for other projects. They still have to add it, and they only ever see its public documents.'}
      </Text>
      <Button type="submit" size="small" disabled={pending}>
        {published ? 'Withdraw' : 'Publish to other projects'}
      </Button>
      {state.error !== undefined && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** Pipeline state and where the store came from, in one row. */
function StoreBadges({ store }: { store: StoreDetail }): ReactElement {
  return (
    <>
      {store.ingestingCount > 0 && (
        <Badge appearance="tint" color="informative">
          {store.ingestingCount} ingesting
        </Badge>
      )}
      {store.failedCount > 0 && (
        <Badge appearance="tint" color="danger">
          {store.failedCount} failed
        </Badge>
      )}
      {store.access === 'shared' && (
        <Badge appearance="tint" color="informative">
          shared by {store.ownerProjectId.slice(0, 8)}
        </Badge>
      )}
      {store.access !== 'shared' && store.visibility === 'public' && (
        <Badge appearance="tint" color="success">
          published
        </Badge>
      )}
    </>
  );
}
