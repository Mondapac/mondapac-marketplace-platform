'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { TAX_INVOICE_SHOWN } from '../storefront/features.ts';
import type { OrderPart } from '../storefront/types.ts';
import { AccountFrame, LineThumb, OrderBadge, PartBadge, useDay } from './account-area.tsx';
import { cancellable, orderTotals, useAccount } from './account-state.tsx';
import { BuyAgain } from './orders.tsx';

const STEPS = ['placed', 'confirmed', 'out-for-delivery', 'delivered'] as const;
const STEP_OF: Record<Exclude<OrderPart['status'], 'cancelled'>, number> = {
  waiting: 0,
  confirmed: 1,
  'out-for-delivery': 2,
  delivered: 3,
};

/**
 * Order details: each seller's part with its progress, lines, delivery fee and the buyer's note;
 * the summary with GST; where it went; Buy again, Get help and, until a seller confirms, Cancel.
 */
export function OrderDetails({
  reference,
  showTaxInvoice = TAX_INVOICE_SHOWN,
}: {
  readonly reference: string;
  readonly showTaxInvoice?: boolean;
}) {
  const t = useTranslations('account');
  const locale = useLocale();
  const day = useDay();
  const { orders, cancelOrder } = useAccount();
  const [asking, setAsking] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  // "Keep order" gives focus back to Cancel order.
  useEffect(() => {
    // After "Yes, cancel order" the button is gone: focus goes to the order's heading.
    if (wasAsking.current && !asking)
      (cancelButton.current ?? document.getElementById('order-title'))?.focus();
    wasAsking.current = asking;
  }, [asking]);
  const order = orders.find((o) => o.reference === reference);
  if (!order) return null;
  const totals = orderTotals(order);
  const money = (m: Parameters<typeof formatMoney>[0]) => formatMoney(m, locale);
  const canCancel = cancellable(order);

  return (
    <AccountFrame title={t('titles.order')}>
      <Link className="back" href="/account/orders">
        <Icon name="chevl" />
        {t('order.back')}
      </Link>
      <section className="ac-card">
        <div className="ac-row">
          <div>
            <h2 id="order-title" tabIndex={-1}>
              {t('order.title', { reference: order.reference })}
            </h2>
            <small className="ac-sub">{t('order.placed', { date: day(order.placedOn) })}</small>
          </div>
          <OrderBadge status={order.status} />
        </div>
        {order.parts.length > 1 ? (
          <p className="ac-note">
            <Icon name="info" />
            <span>{t('order.parts-note', { count: order.parts.length })}</span>
          </p>
        ) : null}
      </section>
      {order.parts.map((part, n) => (
        <section className="ac-card" key={part.sellerId} aria-labelledby={`part-${n}`}>
          <div className="ac-row">
            <h2 id={`part-${n}`}>{part.sellerName}</h2>
            <PartBadge status={part.status} />
          </div>
          <small className="ac-sub">
            {t('order.part', { reference: order.reference, n: n + 1 })} ·{' '}
            {part.status === 'cancelled'
              ? t('order.cancelled-part')
              : part.deliveredOn
                ? t('order.delivered-on', { date: day(part.deliveredOn, false) })
                : part.deliveryWindow}
          </small>
          {part.status === 'cancelled' ? null : <Progress status={part.status} />}
          <div>
            {part.lines.map((line) => (
              <div className="ac-li" key={line.offerId}>
                <LineThumb imageUrl={line.imageUrl} category={line.category} />
                <div>
                  <b>{line.name}</b>
                  <small className="num">
                    {t('order.line', { quantity: line.quantity, price: money(line.unitPrice) })}
                  </small>
                </div>
                <b className="num">
                  {money({
                    amount: line.unitPrice.amount * line.quantity,
                    currency: line.unitPrice.currency,
                  })}
                </b>
              </div>
            ))}
          </div>
          {part.note ? (
            <p className="ac-note">
              <Icon name="note" />
              <span>
                <b>{t('order.your-note')}</b> {part.note}
              </span>
            </p>
          ) : null}
          <dl className="ac-dl">
            <div>
              <dt>{t('order.seller-delivery')}</dt>
              <dd className="num">{money(part.deliveryFee)}</dd>
            </div>
          </dl>
        </section>
      ))}
      <section className="ac-card" aria-labelledby="order-summary">
        <h2 id="order-summary">{t('order.summary')}</h2>
        <dl className="ac-dl">
          <div>
            <dt>{t('order.items', { count: totals.count })}</dt>
            <dd className="num">{money(totals.items)}</dd>
          </div>
          <div>
            <dt>{t('order.delivery')}</dt>
            <dd className="num">{money(totals.delivery)}</dd>
          </div>
          <div className="tot">
            <dt>{t('order.total')}</dt>
            <dd className="num">{money(totals.total)}</dd>
          </div>
        </dl>
        <small className="ac-sub">{t('order.gst', { amount: money(order.includedTax) })}</small>
        {order.status === 'cancelled' ? (
          <p className="ac-note">
            <Icon name="info" />
            <span>{t('order.not-charged')}</span>
          </p>
        ) : null}
      </section>
      <section className="ac-card" aria-labelledby="order-address">
        <h2 id="order-address">{t('order.delivered-to')}</h2>
        <p>{order.deliveredTo}</p>
      </section>
      <div className="ac-acts">
        {order.status === 'cancelled' ? null : <BuyAgain order={order} />}
        {showTaxInvoice && order.status !== 'cancelled' ? (
          <a className="btn ghost" href={`/account/orders/${order.reference}/invoice`}>
            {t('order.tax-invoice')}
          </a>
        ) : null}
        <Link className="btn ghost" href={`/help?order=${encodeURIComponent(order.reference)}`}>
          {t('order.get-help')}
        </Link>
        {canCancel && !asking ? (
          <button
            ref={cancelButton}
            className="btn ghost ac-danger"
            type="button"
            onClick={() => setAsking(true)}
          >
            {t('order.cancel')}
          </button>
        ) : null}
      </div>
      {canCancel && asking ? (
        <div
          className="ac-confirm"
          role="alertdialog"
          aria-labelledby="cancel-title"
          aria-describedby="cancel-body"
        >
          <b id="cancel-title">{t('order.cancel-title', { reference: order.reference })}</b>
          <span id="cancel-body">{t('order.cancel-body')}</span>
          <div className="ac-acts">
            <button
              className="btn ghost ac-danger"
              type="button"
              autoFocus
              onClick={() => {
                cancelOrder(order.reference);
                setAsking(false);
              }}
            >
              {t('order.cancel-yes')}
            </button>
            <button className="btn" type="button" onClick={() => setAsking(false)}>
              {t('order.cancel-no')}
            </button>
          </div>
        </div>
      ) : null}
      {order.status === 'in-progress' && !canCancel ? (
        <p className="ac-note">
          <Icon name="info" />
          <span>{t('order.cancel-late')}</span>
        </p>
      ) : null}
    </AccountFrame>
  );
}

/** The four delivery steps of a seller's part, done up to the current one. */
function Progress({ status }: { readonly status: Exclude<OrderPart['status'], 'cancelled'> }) {
  const t = useTranslations('account.order');
  const at = STEP_OF[status];
  return (
    <ol className="ac-tl" aria-label={t('progress')}>
      {STEPS.map((step, k) => (
        <li
          key={step}
          className={k <= at ? 'on' : undefined}
          aria-current={k === at ? 'step' : undefined}
        >
          <i>{k <= at ? <Icon name="check" /> : null}</i>
          {t(`steps.${step}`)}
        </li>
      ))}
    </ol>
  );
}
