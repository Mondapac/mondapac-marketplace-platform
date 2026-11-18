'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  SkeletonRows,
  SuperTable,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { orderHref } from '../orders/order-href.ts';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { timeOf } from './format.ts';
import { minutesOf } from './security-shared.tsx';
import type { PromotionUsage, PromotionUsages } from './money-types.ts';

const PAGE = 25;

/** The wait of a 429 in whole minutes, or null for any other failure. */
const waitOf = (failure: ApiFailure): number | null =>
  failure.status === 429 ? minutesOf(failure, 60) : null;

type State =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly minutes: number | null }
  | { readonly state: 'denied' }
  | {
      readonly state: 'ready';
      readonly items: readonly PromotionUsage[];
      readonly nextCursor: string | null;
    };

/**
 * The promotions this customer used (customers phase 2b, owner decision 18 Nov): a plain list,
 * newest first, with "Load more" and no total (the API pages by cursor). One row per discount an
 * order took: a stored promotion, the first-order offer or free delivery. The time is when the
 * discount was reserved; a code is never shown, only that one was used. This is not a super list
 * on purpose (recorded as a rule 14 exception). A 403 hides the section.
 */
export function CustomerPromotionUsages({
  accountId,
  zone,
}: {
  readonly accountId: string;
  readonly zone: string;
}) {
  const t = useTranslations('customers.page.money.usages');
  const tp = useTranslations('customers.page');
  const locale = useLocale();
  const [load, setLoad] = useState<State>({ state: 'loading' });
  const [more, setMore] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [moreMinutes, setMoreMinutes] = useState<number | null>(null);
  const [loaded, setLoaded] = useState('');
  const latest = useRef(0);
  const id = encodeURIComponent(accountId);

  const first = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<PromotionUsages>(
      'GET',
      `promotions/admin/customers/${id}/usages?limit=${PAGE}`,
    );
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', items: result.body.items, nextCursor: result.body.nextCursor });
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      setLoad(
        result.failure.status === 403
          ? { state: 'denied' }
          : { state: 'failed', minutes: waitOf(result.failure) },
      );
    }
  }, [id]);

  useEffect(() => {
    void first();
  }, [first]);

  async function loadMore() {
    if (load.state !== 'ready' || load.nextCursor === null) return;
    const ticket = latest.current;
    setMore('busy');
    setLoaded('');
    const result = await callApi<PromotionUsages>(
      'GET',
      `promotions/admin/customers/${id}/usages?limit=${PAGE}&cursor=${encodeURIComponent(load.nextCursor)}`,
    );
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else if (result.failure.status === 403) setLoad({ state: 'denied' });
      else {
        setMoreMinutes(waitOf(result.failure));
        setMore('failed');
      }
      return;
    }
    setMore('idle');
    setMoreMinutes(null);
    setLoaded(t('more-loaded', { count: result.body.items.length }));
    setLoad({
      state: 'ready',
      items: [...load.items, ...result.body.items],
      nextCursor: result.body.nextCursor,
    });
  }

  if (load.state === 'denied') return null;

  const kindName = (kind: string) => (t.has(`kind.${kind}`) ? t(`kind.${kind}`) : kind);
  const columns: SuperColumn<PromotionUsage>[] = [
    {
      id: 'used',
      header: t('col.used'),
      primary: true,
      cell: (row) => <span className="font-medium">{timeOf(row.usedAt, locale, zone)}</span>,
    },
    {
      id: 'offer',
      header: t('col.offer'),
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="wrap-anywhere">{row.promotionName ?? kindName(row.kind)}</span>
          {row.usedCode ? <span className="text-xs text-fg-muted">{t('with-code')}</span> : null}
        </span>
      ),
    },
    {
      id: 'amount',
      header: t('col.amount'),
      numeric: true,
      cell: (row) => formatMinor(row.amountMinor, row.currency, locale),
    },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (row) => (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <Badge
            tone={
              row.status === 'CONFIRMED'
                ? 'success'
                : row.status === 'RELEASED'
                  ? 'neutral'
                  : 'attention'
            }
          >
            {t.has(`status.${row.status}`) ? t(`status.${row.status}`) : row.status}
          </Badge>
          {row.status === 'RELEASED' && row.releaseReason !== null ? (
            <span className="text-xs text-fg-muted">
              {t.has(`release.${row.releaseReason}`)
                ? t(`release.${row.releaseReason}`)
                : row.releaseReason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'order',
      header: t('col.order'),
      cell: (row) => (
        <a
          className="font-medium text-link underline wrap-anywhere"
          href={orderHref(row.orderId, { accountId, tab: 'money' })}
          title={row.orderId}
        >
          {t('order', { id: shortId(row.orderId) })}
        </a>
      ),
    },
  ];

  return (
    <Card title={t('title')}>
      {load.state === 'loading' ? (
        <SkeletonRows label={tp('loading-section', { section: t('title') })} rows={3} />
      ) : load.state === 'failed' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {load.minutes === null
                ? tp('section-failed', { section: t('title') })
                : t('throttled', { minutes: load.minutes })}
            </span>
            <Button variant="secondary" onClick={() => void first()}>
              {tp('retry')}
            </Button>
          </div>
        </Banner>
      ) : (
        <div className="flex flex-col gap-3">
          <SuperTable
            caption={t('title')}
            rows={load.items}
            rowId={(row) => row.id}
            rowName={(row) => row.promotionName ?? kindName(row.kind)}
            columns={columns}
            empty={<EmptyState size="compact" icon="tag" title={t('empty')} />}
          />
          <p role="status" aria-live="polite" className="sr-only">
            {loaded}
          </p>
          <div role="alert">
            {more === 'failed' ? (
              <Banner tone="critical">
                <span>
                  {moreMinutes === null
                    ? t('more-failed')
                    : t('throttled', { minutes: moreMinutes })}
                </span>
              </Banner>
            ) : null}
          </div>
          {load.nextCursor === null ? null : (
            <div>
              <Button
                variant="secondary"
                disabled={more === 'busy'}
                onClick={() => void loadMore()}
              >
                {more === 'failed' ? tp('retry') : t('load-more')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
