'use client';

import { Banner, Button, EmptyState, LoadError, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { DisputesTable } from './disputes-table.tsx';
import { BUCKETS, PAGE_SIZE, type Bucket, type DisputePage, type DisputeRow } from './types.ts';

const ZERO: Readonly<Record<Bucket, number>> = {
  'needs-response': 0,
  'decision-needed': 0,
  'under-review': 0,
  won: 0,
  closed: 0,
};

/**
 * The dispute cases of the Market, one filter chip per bucket with its count, newest first and
 * paged by cursor. Read-only: a case is decided on its own page.
 */
export function DisputesList({ zone }: { readonly zone: string }) {
  const t = useTranslations('disputes');
  const tl = useTranslations('load');
  const [filter, setFilter] = useState<Bucket>('needs-response');
  const [rows, setRows] = useState<readonly DisputeRow[]>([]);
  const [counts, setCounts] = useState<Readonly<Record<Bucket, number>>>(ZERO);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<'first' | 'more' | null>(null);
  const [now] = useState(() => Date.now());
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailed(null);
      // A new first page replaces the list at once: the old bucket's rows never show under a new one.
      if (after === null) {
        setRows([]);
        setNext(null);
      }
      const query = new URLSearchParams({ filter, limit: String(PAGE_SIZE) });
      if (after !== null) query.set('cursor', after);
      const result = await callApi<DisputePage>(
        'GET',
        `commission-payouts/admin/disputes?${query.toString()}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailed(after === null ? 'first' : 'more');
        return;
      }
      setCounts({ ...ZERO, ...result.body.counts });
      setRows((current) => {
        if (after === null) return result.body.disputes;
        const known = new Set(current.map((row) => row.disputeId));
        return [...current, ...result.body.disputes.filter((row) => !known.has(row.disputeId))];
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
      <div role="group" aria-label={t('filters')} className="flex flex-wrap gap-2">
        {BUCKETS.map((bucket) => {
          const on = bucket === filter;
          return (
            <button
              key={bucket}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(bucket)}
              className={`inline-flex min-h-(--mp-size-control) items-center gap-2 rounded-full border px-4 text-sm font-medium ${
                on
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-line-control bg-surface text-fg hover:bg-muted'
              }`}
            >
              {t(`filter.${bucket}`)}
              <span className="tabular-nums">{counts[bucket]}</span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-fg-muted">{t('zone-note', { zone })}</p>
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={() => void load(null)}
        />
      ) : null}
      {rows.length > 0 ? <DisputesTable rows={rows} zone={zone} now={now} /> : null}
      {!loading && failed === null && rows.length === 0 ? (
        <EmptyState icon="shield-check" title={t(`empty.${filter}`)} />
      ) : null}
      {loading ? <SkeletonRows label={t('loading')} rows={rows.length > 0 ? 1 : 3} /> : null}
      {failed === 'more' ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {t('more')}
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-fg-muted">{t('footnote')}</p>
    </div>
  );
}
