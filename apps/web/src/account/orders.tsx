'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { lineLimit } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { useStore } from '../shell/store-context.tsx';
import type { AccountOrder, OrderStatus } from '../storefront/types.ts';
import {
  AccountEmpty,
  AccountFrame,
  LineThumb,
  OrderBadge,
  PartBadge,
  useDay,
} from './account-area.tsx';
import { orderTotals, useAccount } from './account-state.tsx';

type Filter = 'all' | OrderStatus;
const FILTERS: readonly Filter[] = ['all', 'in-progress', 'delivered', 'cancelled'];

/** Orders: a filter and one card per order with each seller's part, View order and Buy again. */
export function AccountOrders() {
  const t = useTranslations('account');
  const locale = useLocale();
  const day = useDay();
  const { orders } = useAccount();
  const [filter, setFilter] = useState<Filter>('all');
  const shown = orders.filter((o) => filter === 'all' || o.status === filter);
  return (
    <AccountFrame title={t('titles.orders')}>
      <div className="ac-seg" role="group" aria-label={t('orders.filter')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`orders.${f}`)}
          </button>
        ))}
      </div>
      {orders.length === 0 ? (
        <AccountEmpty icon="bag" title={t('no-orders')}>
          <p>{t('no-orders-body')}</p>
          <Link className="btn" href="/">
            {t('browse')}
          </Link>
        </AccountEmpty>
      ) : shown.length === 0 ? (
        <AccountEmpty icon="search" title={t('orders.none-here')}>
          <button className="btn ghost" type="button" onClick={() => setFilter('all')}>
            {t('orders.show-all')}
          </button>
        </AccountEmpty>
      ) : (
        <div className="ac-ords">
          {shown.map((order) => (
            <article className="ac-ord" key={order.reference} aria-label={order.reference}>
              <div className="ac-oh">
                <div>
                  <small>{t('overview.order')}</small>
                  <b>{order.reference}</b>
                </div>
                <div>
                  <small>{t('overview.placed')}</small>
                  <b>{day(order.placedOn)}</b>
                </div>
                <div>
                  <small>{t('overview.total')}</small>
                  <b className="num">{formatMoney(orderTotals(order).total, locale)}</b>
                </div>
                <OrderBadge status={order.status} />
              </div>
              <div className="ac-ob">
                {order.parts.map((part) => (
                  <div className="ac-part" key={part.sellerId}>
                    <h3>
                      {part.sellerName}
                      <PartBadge status={part.status} />
                    </h3>
                    <div className="ac-thumbs">
                      {part.lines.map((line) => (
                        <LineThumb
                          key={line.offerId}
                          imageUrl={line.imageUrl}
                          category={line.category}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className="ac-acts">
                  <Link
                    className="btn"
                    href={`/account/orders/${order.reference}`}
                    aria-label={t('orders.view-order', { reference: order.reference })}
                  >
                    {t('overview.view-order')}
                  </Link>
                  {order.status === 'cancelled' ? null : <BuyAgain order={order} ghost />}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </AccountFrame>
  );
}

/**
 * Buy again: each line still sold is added to the cart with its quantity, at today's price and
 * within the line's limit. The button then says it is done.
 */
export function BuyAgain({
  order,
  ghost = false,
}: {
  readonly order: AccountOrder;
  readonly ghost?: boolean;
}) {
  const t = useTranslations('account.orders');
  const { add, cartSource } = useStore();
  const [done, setDone] = useState(false);
  return (
    <button
      className={ghost ? 'btn ghost' : 'btn'}
      type="button"
      disabled={done}
      onClick={() => {
        for (const part of order.parts)
          for (const line of part.lines) {
            const item = cartSource.items[line.offerId];
            if (!item) continue;
            for (let n = 0; n < line.quantity; n++)
              add(line.offerId, item.price, lineLimit(item.lowStock));
          }
        setDone(true);
      }}
    >
      <span aria-live="polite">{done ? t('added') : t('buy-again')}</span>
    </button>
  );
}
