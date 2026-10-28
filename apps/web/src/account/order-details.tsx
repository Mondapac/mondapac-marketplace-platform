'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { TAX_INVOICE_SHOWN } from '../storefront/features.ts';
import type { AccountOrder, OrderPart, PickupCode } from '../storefront/types.ts';
import { AccountFrame, LineThumb, OrderBadge, PartBadge, useDay } from './account-area.tsx';
import { cancellable, orderTotals, useAccount } from './account-state.tsx';
import { BuyAgain } from './orders.tsx';

/** The tracking link as it may be shown: an absolute https URL, else null (never rendered). */
export function safeTrackingHref(value: string | undefined): string | null {
  if (value === undefined || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The tracking link is useful while the part is confirmed or on its way, not once it is over. */
const TRACKABLE: ReadonlySet<OrderPart['status']> = new Set(['confirmed', 'out-for-delivery']);

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
  order: given,
  showTaxInvoice = TAX_INVOICE_SHOWN,
}: {
  /** The page's key: a sample order's reference, or a real order's id. */
  readonly reference: string;
  /** A real order the page read on the server; otherwise it is looked up in the account. */
  readonly order?: AccountOrder;
  readonly showTaxInvoice?: boolean;
}) {
  const t = useTranslations('account');
  const locale = useLocale();
  const day = useDay();
  const { orders, cancelOrder, renewPickupCode } = useAccount();
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
  const order = given ?? orders.find((o) => (o.id ?? o.reference) === reference);
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
          {!TRACKABLE.has(part.status) || safeTrackingHref(part.trackingUrl) === null ? null : (
            <p className="ac-track">
              <a
                className="btn ghost"
                href={safeTrackingHref(part.trackingUrl) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="truck" />
                {t('order.track')}
                <Icon name="external" />
                <span className="sr-only"> {t('order.track-new-tab')}</span>
              </a>
            </p>
          )}
          {part.pickup ? (
            <PickupCodeCard
              pickup={part.pickup}
              sellerName={part.sellerName}
              onRenew={() => renewPickupCode(order.reference, part.sellerId)}
            />
          ) : null}
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
        {order.taxKnown === false ? null : (
          <small className="ac-sub">{t('order.gst', { amount: money(order.includedTax) })}</small>
        )}
        {/* A sample order is cancelled only before a seller confirms it; a real one may have been paid. */}
        {order.status === 'cancelled' && order.id === undefined ? (
          <p className="ac-note">
            <Icon name="info" />
            <span>{t('order.not-charged')}</span>
          </p>
        ) : null}
      </section>
      {order.deliveredTo === '' ? null : (
        <section className="ac-card" aria-labelledby="order-address">
          <h2 id="order-address">{t('order.delivered-to')}</h2>
          <p>{order.deliveredTo}</p>
        </section>
      )}
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
              onClick={() => {
                cancelOrder(order.reference);
                setAsking(false);
              }}
            >
              {t('order.cancel-yes')}
            </button>
            <button className="btn" type="button" autoFocus onClick={() => setAsking(false)}>
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

/**
 * The code the buyer shows the seller at the handover, in four boxes. Digits always read left to
 * right, whatever the page direction. Only this page shows it; it is not sent by email.
 */
function PickupCodeCard({
  pickup,
  sellerName,
  onRenew,
}: {
  readonly pickup: PickupCode;
  readonly sellerName: string;
  readonly onRenew: () => void;
}) {
  const t = useTranslations('account.order.pickup');
  const heading = useId();
  const [renewed, setRenewed] = useState(false);
  return (
    <div className="ac-pickup" role="group" aria-labelledby={heading}>
      <h3 id={heading}>{t('title', { seller: sellerName })}</h3>
      <p className="ac-pickup-hint">{t('hint')}</p>
      <div
        className="ac-pickup-code"
        dir="ltr"
        role="img"
        aria-label={pickup.code.split('').join(' ')}
      >
        {pickup.code.split('').map((digit, k) => (
          <span key={k} className="num" aria-hidden="true">
            {digit}
          </span>
        ))}
      </div>
      {pickup.locked ? (
        <p className="ac-note ac-warn">
          <Icon name="info" />
          <span>{t('locked')}</span>
        </p>
      ) : pickup.attemptsLeft < 5 ? (
        <small className="ac-sub">{t('tries', { count: pickup.attemptsLeft })}</small>
      ) : null}
      <button
        className={pickup.locked ? 'btn' : 'btn ghost'}
        type="button"
        onClick={() => {
          onRenew();
          setRenewed(true);
        }}
      >
        {t('renew')}
      </button>
      <small className="ac-sub">{t('renew-note')}</small>
      <p className="ac-sub" role="status" aria-live="polite">
        {renewed ? t('renewed') : ''}
      </p>
    </div>
  );
}
