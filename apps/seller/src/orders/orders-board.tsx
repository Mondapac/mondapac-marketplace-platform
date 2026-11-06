'use client';

import { Badge, Banner, Button, EmptyState, Tabs } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { NO_DAYS, queryOf } from './orders-query.ts';
import { shortId, statusOf, TONE } from './status.ts';
import type { Fulfilment, SellerOrderPage, SellerOrderView } from './types.ts';

/** The board's stages, in the order an order moves through them. */
export const BOARD_STAGES = ['to-ship', 'ready', 'shipped', 'delivered'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

/** The API lists "ready" orders under the to-ship filter, so two stages share one list. */
const SOURCE_OF: Readonly<Record<BoardStage, Fulfilment>> = {
  'to-ship': 'to-ship',
  ready: 'to-ship',
  shipped: 'shipped',
  delivered: 'delivered',
};
const SOURCES: readonly Fulfilment[] = ['to-ship', 'shipped', 'delivered'];

interface Source {
  readonly orders: readonly SellerOrderView[];
  readonly next: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly loaded: boolean;
}
type Sources = Readonly<Record<Fulfilment, Source>>;

const EMPTY: Source = { orders: [], next: null, loading: true, failed: false, loaded: false };
const FRESH: Sources = { 'to-ship': EMPTY, shipped: EMPTY, delivered: EMPTY };

/**
 * The seller's paid orders as stage columns (To ship, Ready, Shipped, Delivered). Each stage
 * lists newest first and loads more by cursor, whatever the List paging setting says, so a column
 * never hides orders behind a page number. From 768 px the columns sit side by side (two across
 * on a tablet, four from 1024 px); on a phone one stage shows at a time, picked from the tab row.
 */
export function OrdersBoard() {
  const t = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  const [sources, setSources] = useState<Sources>(FRESH);
  const [stage, setStage] = useState<BoardStage>('to-ship');
  // A stage answers only the request it asked last; an older answer is dropped.
  const tickets = useRef<Record<Fulfilment, number>>({ 'to-ship': 0, shipped: 0, delivered: 0 });

  const load = useCallback(async (source: Fulfilment, cursor: string | null) => {
    const ticket = ++tickets.current[source];
    setSources((all) => ({ ...all, [source]: { ...all[source], loading: true, failed: false } }));
    const result = await callApi<SellerOrderPage>(
      'GET',
      queryOf(source, NO_DAYS, { paging: 'prev-next', cursor }),
    );
    if (ticket !== tickets.current[source]) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setSources((all) => ({
        ...all,
        [source]: { ...all[source], loading: false, failed: true, loaded: true },
      }));
      return;
    }
    setSources((all) => ({
      ...all,
      [source]: {
        orders:
          cursor === null
            ? result.body.sellerOrders
            : [...all[source].orders, ...result.body.sellerOrders],
        next: result.body.nextCursor,
        loading: false,
        failed: false,
        loaded: true,
      },
    }));
  }, []);

  useEffect(() => {
    for (const source of SOURCES) void load(source, null);
  }, [load]);

  const inStage = (id: BoardStage): readonly SellerOrderView[] =>
    sources[SOURCE_OF[id]].orders.filter((order) => {
      const status = statusOf(order);
      if (id === 'to-ship') return status === 'to-ship';
      return status === id;
    });

  const everyLoaded = SOURCES.every((s) => sources[s].loaded && !sources[s].loading);
  const nothing =
    everyLoaded && SOURCES.every((s) => sources[s].orders.length === 0 && !sources[s].failed);
  if (nothing) {
    return (
      <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
    );
  }

  const number = (n: number) => n.toLocaleString(locale);
  const countLabel = (id: BoardStage) => {
    const source = sources[SOURCE_OF[id]];
    const shown = number(inStage(id).length);
    return source.next !== null ? `${shown}+` : shown;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="md:hidden">
        <Tabs
          label={t('board.stages')}
          activeId={stage}
          onSelect={(id) => setStage(id as BoardStage)}
          items={BOARD_STAGES.map((id) => ({
            id,
            label: `${t(`status.${id}`)} (${countLabel(id)})`,
          }))}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {BOARD_STAGES.map((id) => {
          const source = sources[SOURCE_OF[id]];
          const orders = inStage(id);
          return (
            <section
              key={id}
              aria-labelledby={`board-${id}`}
              data-stage={id}
              className={`${stage === id ? 'flex' : 'max-md:hidden md:flex'} min-w-0 flex-col gap-3 rounded-lg border border-line bg-muted p-3`}
            >
              <h2
                id={`board-${id}`}
                className="flex items-center justify-between gap-2 px-1 text-sm font-semibold"
              >
                <span>{t(`status.${id}`)}</span>
                <span className="font-normal tabular-nums text-fg-muted">{countLabel(id)}</span>
              </h2>
              {source.failed ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
              {orders.length === 0 && !source.loading && !source.failed ? (
                <p className="px-1 py-4 text-sm text-fg-muted">{t('board.empty')}</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {orders.map((order) => (
                    <li key={order.sellerOrderId}>
                      <OrderCard order={order} locale={locale} zone={zone} />
                    </li>
                  ))}
                </ul>
              )}
              {source.loading && !source.loaded ? (
                <p className="px-1 text-sm text-fg-muted" aria-live="polite">
                  {t('board.loading')}
                </p>
              ) : null}
              {source.next !== null || source.failed ? (
                <Button
                  variant="secondary"
                  disabled={source.loading}
                  onClick={() => void load(SOURCE_OF[id], source.failed ? null : source.next)}
                >
                  {source.failed ? t('board.retry') : t('board.more')}
                </Button>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function OrderCard({
  order,
  locale,
  zone,
}: {
  readonly order: SellerOrderView;
  readonly locale: string;
  readonly zone: string | undefined;
}) {
  const t = useTranslations('orders');
  const count = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const status = statusOf(order);
  return (
    <a
      href={`/orders/${order.sellerOrderId}`}
      className="flex min-h-11 flex-col gap-1 rounded-lg border border-line bg-surface p-3 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words font-medium text-link underline">
          {t('ref', { id: shortId(order.sellerOrderId) })}
        </span>
        <Badge tone={TONE[status]}>{t(`status.${status}`)}</Badge>
      </span>
      <span className="text-fg-muted">
        <time dateTime={order.paidAt}>{shortInstant(order.paidAt, locale, zone)}</time>
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="text-fg-muted">{t('items-count', { count })}</span>
        <span className="font-medium tabular-nums">
          {formatMinor(order.total.amount, order.total.currency, locale)}
        </span>
      </span>
      <span className="text-fg-muted">{t(`method.${order.deliveryMethod}`)}</span>
    </a>
  );
}
