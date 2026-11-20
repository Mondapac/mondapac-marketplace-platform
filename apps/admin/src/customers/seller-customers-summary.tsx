'use client';

import { Button, Card, LoadError, SkeletonRows } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { minutesOf } from './security-shared.tsx';
import {
  parseSellerCustomersSummary,
  SELLER_VIEWS,
  type SellerCustomersSummary,
  type SellerView,
} from './seller-customers-types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'denied' }
  | { readonly state: 'failed'; readonly minutes: number | null }
  | { readonly state: 'ready'; readonly summary: SellerCustomersSummary };

/** "2026-03" as a month and year, read in UTC so the zone of the cut never shifts the label. */
export function monthLabel(month: string, locale: string): string {
  const [year, number] = month.split('-').map(Number);
  if (year === undefined || number === undefined || Number.isNaN(year) || Number.isNaN(number)) {
    return month;
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, number - 1, 1)));
}

/**
 * The head of a seller's Customers tab (customers management phase 3): the four counts as tiles
 * and the last 12 months of new buyers, new followers and new exclusive customers, as bars with a table alternative (the
 * table is the default on a phone under 480 px). The section owns its card: a 403 removes it.
 */
export function SellerCustomersSummaryCard({
  sellerId,
  onDenied,
}: {
  readonly sellerId: string;
  readonly onDenied?: () => void;
}) {
  const t = useTranslations('customers.seller-tab.summary');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [table, setTable] = useState(false);

  const read = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<unknown>(
      'GET',
      `customers/admin/sellers/${encodeURIComponent(sellerId)}/customers/summary`,
    );
    if (result.ok) {
      const summary = parseSellerCustomersSummary(result.body);
      setLoad(summary === null ? { state: 'failed', minutes: null } : { state: 'ready', summary });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.status === 403) {
      setLoad({ state: 'denied' });
      onDenied?.();
      return;
    }
    setLoad({
      state: 'failed',
      minutes: result.failure.status === 429 ? minutesOf(result.failure, 60) : null,
    });
  }, [sellerId, onDenied]);

  useEffect(() => {
    void read();
  }, [read]);

  // A phone under 480 px reads the table first.
  useEffect(() => {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 479px)').matches
    ) {
      setTable(true);
    }
  }, []);

  if (load.state === 'denied') return null;
  const number = (value: number) => numberFormat(locale, {}).format(value);

  if (load.state === 'loading') {
    return (
      <Card title={t('title')}>
        <SkeletonRows label={t('loading')} rows={2} />
      </Card>
    );
  }
  if (load.state === 'failed') {
    return (
      <Card title={t('title')}>
        <LoadError
          className="flex flex-col items-start gap-3"
          message={load.minutes === null ? t('error') : t('throttled', { minutes: load.minutes })}
          retryLabel={tl('retry')}
          onRetry={() => void read()}
        />
      </Card>
    );
  }

  const { summary } = load;
  const peak = Math.max(
    1,
    ...summary.months.flatMap((m) => [m.newBuyers, m.newFollowers, m.newExclusive]),
  );
  const tileLabel = (view: SellerView) => t(`tile.${view}`);

  return (
    <Card title={t('title')}>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('tiles')}>
        {SELLER_VIEWS.map((view) => (
          <li key={view} className="rounded-lg border border-line bg-subtle p-4">
            <p className="text-sm text-fg-secondary">{tileLabel(view)}</p>
            <p className="mt-1 text-2xl font-semibold text-fg">{number(summary.counts[view])}</p>
            {view === 'referred' ? (
              <p className="mt-1 text-xs text-fg-muted">{t('referred-hint')}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-fg">{t('trend.title')}</h3>
          <p className="text-sm text-fg-muted">{t('trend.zone', { zone: summary.zone })}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={table}
          onClick={() => setTable((value) => !value)}
        >
          {table ? t('trend.show-chart') : t('trend.show-table')}
        </Button>
      </div>

      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <caption className="sr-only">{t('trend.caption')}</caption>
            <thead>
              <tr className="border-b border-line text-fg-secondary">
                <th scope="col" className="py-2 pe-4 text-start font-medium">
                  {t('trend.month')}
                </th>
                <th scope="col" className="py-2 pe-4 text-end font-medium">
                  {t('trend.new-buyers')}
                </th>
                <th scope="col" className="py-2 pe-4 text-end font-medium">
                  {t('trend.new-followers')}
                </th>
                <th scope="col" className="py-2 text-end font-medium">
                  {t('trend.new-exclusive')}
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.months.map((m) => (
                <tr key={m.month} className="border-b border-line-row">
                  <th scope="row" className="py-2 pe-4 text-start font-normal">
                    {monthLabel(m.month, locale)}
                  </th>
                  <td className="py-2 pe-4 text-end tabular-nums">{number(m.newBuyers)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{number(m.newFollowers)}</td>
                  <td className="py-2 text-end tabular-nums">{number(m.newExclusive)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <ul
            className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-secondary"
            aria-label={t('trend.legend')}
          >
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-accent" />
              {t('trend.new-buyers')}
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-info-fg" />
              {t('trend.new-followers')}
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-success-fg" />
              {t('trend.new-exclusive')}
            </li>
          </ul>
          {/* The figures are exact in the table; the bars are an overview, so they are hidden from
              assistive technology and the toggle above gives the same data as a table. */}
          <div
            role="img"
            aria-label={t('trend.chart-label', { zone: summary.zone })}
            className="flex h-40 items-end gap-2 overflow-x-auto border-b border-line pb-px"
          >
            {summary.months.map((m) => (
              <div key={m.month} className="flex min-w-8 flex-1 flex-col items-center gap-1">
                <div className="flex h-32 w-full items-end justify-center gap-1">
                  <span
                    className="w-1/3 rounded-t-sm bg-accent"
                    style={{ height: `${(m.newBuyers / peak) * 100}%` }}
                    title={`${t('trend.new-buyers')}: ${number(m.newBuyers)}`}
                  />
                  <span
                    className="w-1/3 rounded-t-sm bg-info-fg"
                    style={{ height: `${(m.newFollowers / peak) * 100}%` }}
                    title={`${t('trend.new-followers')}: ${number(m.newFollowers)}`}
                  />
                  <span
                    className="w-1/3 rounded-t-sm bg-success-fg"
                    style={{ height: `${(m.newExclusive / peak) * 100}%` }}
                    title={`${t('trend.new-exclusive')}: ${number(m.newExclusive)}`}
                  />
                </div>
                <span className="text-xs text-fg-muted">{monthLabel(m.month, locale)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
