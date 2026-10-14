'use client';

import { Banner, Button, LoadError } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { AccountsTable } from './accounts-table.tsx';
import {
  FILTERS,
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
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailed(null);
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
      {/* One row that scrolls sideways on a phone, rather than tabs wrapping onto two lines. */}
      <nav aria-label={t('tabs')} className="flex gap-4 overflow-x-auto border-b border-line">
        {FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={id === filter ? 'page' : undefined}
            onClick={() => setFilter(id)}
            className={
              id === filter
                ? 'min-h-12 shrink-0 whitespace-nowrap border-b-2 border-link px-1 font-medium text-fg'
                : 'min-h-12 shrink-0 whitespace-nowrap border-b-2 border-transparent px-1 text-fg-muted hover:text-fg'
            }
          >
            {t(id === 'all' ? 'tab.all' : `status.${id}`)}
          </button>
        ))}
      </nav>
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={() => void load(null)}
        />
      ) : null}
      {rows.length > 0 ? <AccountsTable rows={rows} /> : null}
      {!loading && failed === null && rows.length === 0 ? (
        <div className="rounded-lg border border-line p-6">
          <p className="font-medium">{t(filter === 'all' ? 'empty.all' : 'empty.status')}</p>
        </div>
      ) : null}
      {loading ? <p className="text-fg-muted">{t('loading')}</p> : null}
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
