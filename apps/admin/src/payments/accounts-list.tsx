'use client';

import {
  Banner,
  Button,
  EmptyState,
  LoadError,
  Tabs,
  ListLoadingStatus,
  ListRefreshing,
  TableSkeleton,
  useListLoading,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { AccountsTable } from './accounts-table.tsx';
import {
  FILTERS,
  PAGE_SIZE,
  type ConnectedAccountPage,
  type ConnectedAccountRow,
  type StatusFilter,
} from './types.ts';

/**
 * The connected accounts of the sellers (read-only): a tab for each status, newest first,
 * paged by cursor with "Show more".
 */
export function AccountsList() {
  const t = useTranslations('payments.accounts');
  const tl = useTranslations('load');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [rows, setRows] = useState<readonly ConnectedAccountRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<'first' | 'more' | null>(null);
  const status = useListLoading(loading, rows.length > 0);
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailed(null);
      // A new first page replaces the list at once: the old tab's rows never show under a new tab.
      if (after === null) {
        setRows([]);
        setNext(null);
      }
      const query = new URLSearchParams();
      if (filter !== 'all') query.set('status', filter);
      if (after !== null) query.set('cursor', after);
      const text = query.toString();
      const result = await callApi<ConnectedAccountPage>(
        'GET',
        `payments/admin/connected-accounts${text === '' ? '' : `?${text}`}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailed(after === null ? 'first' : 'more');
        if (after === null) {
          setRows([]);
          setNext(null);
        }
        return;
      }
      setRows((current) => {
        if (after === null) return result.body.items;
        const known = new Set(current.map((row) => row.sellerId));
        return [...current, ...result.body.items.filter((row) => !known.has(row.sellerId))];
      });
      setNext(result.body.nextCursor);
    },
    [filter],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <Tabs
        label={t('tabs')}
        activeId={filter}
        onSelect={(id) => setFilter(id as typeof filter)}
        items={FILTERS.map((id) => ({ id, label: t(id === 'all' ? 'tab.all' : `status.${id}`) }))}
      />
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={() => void load(null)}
        />
      ) : null}
      {rows.length > 0 ? (
        <ListRefreshing refreshing={status.refreshing} busy={loading}>
          <AccountsTable rows={rows} />
        </ListRefreshing>
      ) : null}
      {!loading && failed === null && rows.length === 0 ? (
        <EmptyState icon="wallet" title={t(filter === 'all' ? 'empty.all' : 'empty.status')} />
      ) : null}
      {loading && rows.length === 0 ? (
        <TableSkeleton
          label={t('loading')}
          slowLabel={tl('slow')}
          rows={PAGE_SIZE}
          columns={[
            { header: t('col.seller'), kind: 'title' },
            { header: t('col.status'), kind: 'status' },
            { header: t('col.ready'), kind: 'status', place: 'labelled' },
            { header: t('col.requirements'), kind: 'number' },
            { header: t('col.cooling-off-utc'), kind: 'date' },
            { header: t('col.paused'), kind: 'status', place: 'labelled' },
            { header: t('col.last-read-utc'), kind: 'date' },
          ]}
        />
      ) : null}
      {loading && rows.length > 0 ? (
        <ListLoadingStatus label={t('loading')} slow={false} slowLabel={tl('slow')} />
      ) : null}
      {failed === 'more' ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {t('more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
