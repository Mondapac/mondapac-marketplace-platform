'use client';

import {
  Badge,
  Button,
  CARD_TABLE,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
  Tabs,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstantInZone } from '../shared/format.ts';
import {
  API_BLOG_POSTS,
  OWNER_TYPES,
  POST_KINDS,
  POST_STATUSES,
  type KindFilter,
  type OwnerFilter,
  type PostPage,
  type PostRow,
  type PostStatus,
  type StatusFilter,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed';

const STATUS_TONE: Record<PostStatus, 'success' | 'info' | 'attention' | 'neutral'> = {
  draft: 'neutral',
  in_review: 'info',
  changes_requested: 'attention',
  approved: 'info',
  scheduled: 'info',
  published: 'success',
  unpublished: 'neutral',
  archived: 'neutral',
};

/** What the second line of a row says about the version being worked on, if anything. */
function openNote(row: PostRow): 'in_review' | 'returned' | 'draft' | 'approved' | null {
  // A post that is itself a draft, in review or sent back is already described by its status.
  if (row.status === 'draft' || row.status === 'in_review' || row.status === 'changes_requested') {
    return null;
  }
  switch (row.openState) {
    case 'in_review':
    case 'returned':
    case 'draft':
    case 'approved':
      return row.openState;
    default:
      return null;
  }
}

/**
 * The posts of the Market (admin): status tabs, type and author filters, 50 a page. Read only: it
 * has no buttons of its own; the editor and the review pages arrive with their own packages.
 */
export function PostsView({ zone }: { readonly zone: string }) {
  const t = useTranslations('blog');
  const locale = useLocale();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [owner, setOwner] = useState<OwnerFilter>('all');
  const [rows, setRows] = useState<readonly PostRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [load, setLoad] = useState<Load>('loading');
  const [more, setMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const latest = useRef(0);

  const queryOf = useCallback(
    (pageNumber: number) => {
      const query = new URLSearchParams();
      if (status !== 'all') query.set('status', status);
      if (kind !== 'all') query.set('kind', kind);
      if (owner !== 'all') query.set('owner', owner);
      if (pageNumber > 1) query.set('page', String(pageNumber));
      const text = query.toString();
      return `${API_BLOG_POSTS}${text === '' ? '' : `?${text}`}`;
    },
    [status, kind, owner],
  );

  const fetchRows = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    setMoreFailed(false);
    const result = await callApi<PostPage>('GET', queryOf(1));
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setRows([]);
      setLoad('failed');
      return;
    }
    setRows(result.body.items);
    setPage(result.body.page);
    setHasMore(result.body.hasMore);
    setLoad('ready');
  }, [queryOf]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  async function loadMore() {
    if (!hasMore || more) return;
    setMore(true);
    setMoreFailed(false);
    const result = await callApi<PostPage>('GET', queryOf(page + 1));
    setMore(false);
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setMoreFailed(true);
      return;
    }
    setRows((previous) => [...previous, ...result.body.items]);
    setPage(result.body.page);
    setHasMore(result.body.hasMore);
  }

  const filtered = status !== 'all' || kind !== 'all' || owner !== 'all';
  const when = (row: PostRow) => shortInstantInZone(row.updatedAt, locale, zone);
  const authorOf = (row: PostRow) =>
    row.ownerType === 'platform' ? t('author.platform') : t('author.seller');

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        label={t('tabs-label')}
        activeId={status}
        onSelect={(id) => setStatus(id as StatusFilter)}
        items={[
          { id: 'all', label: t('status.all') },
          ...POST_STATUSES.map((value) => ({ id: value, label: t(`status.${value}`) })),
        ]}
      />
      <div role="search" aria-label={t('filter-label')} className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-48">
          <Select
            label={t('kind-filter')}
            value={kind}
            options={[
              { value: 'all', label: t('kind.all') },
              ...POST_KINDS.map((value) => ({ value, label: t(`kind.${value}`) })),
            ]}
            onChange={(event) => setKind(event.target.value as KindFilter)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            label={t('owner-filter')}
            value={owner}
            options={[
              { value: 'all', label: t('owner.all') },
              ...OWNER_TYPES.map((value) => ({ value, label: t(`owner.${value}`) })),
            ]}
            onChange={(event) => setOwner(event.target.value as OwnerFilter)}
          />
        </div>
      </div>
      <p className="text-sm text-fg-muted">{t('zone-note', { zone })}</p>
      <p role="status" className="sr-only">
        {load === 'ready' ? t('result-count', { count: rows.length }) : ''}
      </p>
      {load === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {load === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('load-error')}
          retryLabel={t('retry')}
          onRetry={() => void fetchRows()}
        />
      ) : null}
      {load === 'ready' && rows.length === 0 ? (
        <EmptyState icon="file" title={t(filtered ? 'empty-filtered' : 'empty')} />
      ) : null}
      {load === 'ready' && rows.length > 0 ? (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                {['post', 'kind', 'author', 'status', 'updated'].map((col) => (
                  <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(`col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {rows.map((row) => {
                const note = openNote(row);
                return (
                  <tr key={row.id} className={CARD_TABLE.row}>
                    <td className={`${CARD_TABLE.cell} min-w-0`}>
                      <p className="font-semibold wrap-anywhere text-fg">{row.title}</p>
                      <p className="text-sm wrap-anywhere text-fg-muted">{`/blog/${row.slug}`}</p>
                      {note === null ? null : (
                        <p className="text-sm text-fg-muted">{t(`open-note.${note}`)}</p>
                      )}
                      {row.featured ? (
                        <p className="text-sm text-fg-muted">{t('featured')}</p>
                      ) : null}
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('col.kind')}>
                      {t(`kind.${row.kind}`)}
                    </td>
                    <td
                      className={`${CARD_TABLE.labelled} whitespace-nowrap`}
                      data-label={t('col.author')}
                    >
                      {authorOf(row)}
                    </td>
                    <td className={CARD_TABLE.corner}>
                      <Badge tone={STATUS_TONE[row.status]}>{t(`state.${row.status}`)}</Badge>
                      {row.status === 'scheduled' && row.scheduledAt !== null ? (
                        <p className="mt-1 text-sm text-fg-muted">
                          {shortInstantInZone(row.scheduledAt, locale, zone)}
                        </p>
                      ) : null}
                    </td>
                    <td
                      className={`${CARD_TABLE.labelled} whitespace-nowrap text-fg-muted`}
                      data-label={t('col.updated')}
                    >
                      {when(row)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {moreFailed ? (
        <p role="alert" className="text-critical-fg">
          {t('more-error')}
        </p>
      ) : null}
      {load === 'ready' && hasMore ? (
        <p>
          <Button
            variant="secondary"
            loading={more}
            disabled={more}
            onClick={() => void loadMore()}
          >
            {t('more')}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
