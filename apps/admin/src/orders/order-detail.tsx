import { BackLink, Banner, Card, DataList, EmailText, type DataListRow } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../pricing/format.ts';
import { known } from '../sellers/format.ts';
import { formatInstant } from '../shared/format.ts';
import { numberFormat } from '../shared/intl.ts';
import { shortId } from '../shared/short-id.ts';
import { CopyOrderId } from './copy-order-id.tsx';
import { FallbackId, FullId } from './fallback-id.tsx';
import { orderEvents, type OrderEvent } from './order-activity.ts';
import { FulfilmentBadge, OrderStatusBadge } from './status-badge.tsx';
import {
  CANCEL_REASONS,
  DELIVERY_METHODS,
  PAYMENT_STATES,
  type AdminOrder,
  type OrderLine,
  type SellerPart,
} from './types.ts';

/**
 * One order for support and oversight (read-only). The main column follows the money and the
 * goods: each seller's part, then the payment. The side column holds who ordered and what has
 * happened. The panel is English and left to right.
 */
export function OrderDetail({
  order,
  canViewCustomer,
}: {
  readonly order: AdminOrder;
  /** Whether the admin holds identity.customer-account.view; tells "hidden" from "failed to load". */
  readonly canViewCustomer: boolean;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-4">
      <BackLink href="/orders" label={t('detail.back')} />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold break-words">
            {t('reference', { id: shortId(order.orderId) })}
          </h1>
          <OrderStatusBadge status={order.status} />
        </div>
        <p className="text-sm text-fg-muted break-all">{order.orderId}</p>
        <p className="text-sm text-fg-muted">
          {t('detail.meta', {
            placed: formatInstant(order.createdAt, locale),
            sellers: order.sellerOrders.length,
            total: formatMoney(order.total, locale),
          })}
        </p>
        <CopyOrderId orderId={order.orderId} />
      </header>
      {order.cancelReason === null ? null : (
        <Banner tone="info">
          {t('detail.cancelled-banner', {
            reason: t(`cancel-reason.${known(order.cancelReason, CANCEL_REASONS)}`),
          })}
        </Banner>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {order.sellerOrders.length === 0 ? (
            <Banner tone="info">{t('detail.no-parts')}</Banner>
          ) : (
            order.sellerOrders.map((part, index) => (
              <SellerPartCard
                key={part.sellerId}
                part={part}
                paid={order.status === 'confirmed'}
                index={index + 1}
                count={order.sellerOrders.length}
              />
            ))
          )}
          <PaymentCard order={order} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <CustomerCard order={order} canView={canViewCustomer} />
          <ActivityCard order={order} />
        </div>
      </div>
    </div>
  );
}

function PaymentCard({ order }: { readonly order: AdminOrder }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const rows: readonly DataListRow[] = [
    {
      label: t('field.payment'),
      value: t(`payment.${known(order.paymentState, PAYMENT_STATES)}`),
    },
    {
      label: t('field.paid'),
      value: order.confirmedAt && formatInstant(order.confirmedAt, locale),
    },
    ...(order.cancelledAt === null
      ? []
      : [{ label: t('field.cancelled'), value: formatInstant(order.cancelledAt, locale) }]),
    ...(order.payBy === null
      ? []
      : [{ label: t('field.pay-by'), value: formatInstant(order.payBy, locale) }]),
    {
      label: t('field.payment-intent'),
      value: order.paymentIntentId && <span className="break-all">{order.paymentIntentId}</span>,
    },
    {
      label: t('field.tax'),
      value: order.tax === null ? t('tax.not-recorded') : formatMoney(order.tax, locale),
    },
    {
      label: t('field.tax-strategy'),
      value:
        order.tax === null ? null : order.taxStrategyId === null ? (
          t('tax.built-in')
        ) : (
          <FullId id={order.taxStrategyId} />
        ),
    },
    { label: t('field.total'), value: formatMoney(order.total, locale) },
  ];
  return (
    <Card title={t('detail.payment')}>
      <DataList rows={rows} missing={t('none')} />
    </Card>
  );
}

function CustomerCard({
  order,
  canView,
}: {
  readonly order: AdminOrder;
  readonly canView: boolean;
}) {
  const t = useTranslations('orders');
  const rows: readonly DataListRow[] = [
    ...(order.customer === null
      ? []
      : [
          { label: t('field.customer-name'), value: order.customer.displayName?.trim() || null },
          { label: t('field.customer-email'), value: <EmailText address={order.customer.email} /> },
        ]),
    { label: t('field.customer'), value: <FullId id={order.accountId} /> },
  ];
  return (
    <Card title={t('detail.customer')}>
      {order.customer === null ? (
        <p className="text-sm text-fg-muted">
          {t(canView ? 'detail.customer-unavailable' : 'detail.no-customer')}
        </p>
      ) : null}
      <dl className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={String(row.label)} className="flex min-w-0 flex-col">
            <dt className="text-sm text-fg-muted">{row.label}</dt>
            <dd className="min-w-0 font-medium break-words">{row.value || t('none')}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function ActivityCard({ order }: { readonly order: AdminOrder }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const events = orderEvents(order);
  return (
    <Card title={t('detail.activity')}>
      <ol className="flex flex-col gap-3">
        {events.map((event, index) => (
          <li key={`${event.kind}-${index}`} className="flex flex-col">
            <span>{eventText(event, t)}</span>
            <span className="text-sm text-fg-muted">{formatInstant(event.at, locale)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function eventText(event: OrderEvent, t: ReturnType<typeof useTranslations>): string {
  if (!('sellerId' in event)) return t(`event.${event.kind}`);
  return t(`event.${event.kind}`, {
    seller: event.storeName?.trim() || t('detail.seller', { id: shortId(event.sellerId) }),
  });
}

/**
 * Ready, shipped and delivered as they stand: done with a time, or waiting. A pickup part has no
 * shipping: Ready for pickup, then Collected. Nothing is shown before payment or after a cancel.
 */
function FulfilmentSteps({ part }: { readonly part: SellerPart }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const pickup = part.deliveryMethod === 'pickup';
  const delivered = part.deliveredAt !== null || part.fulfilment === 'delivered';
  const shipped = part.shippedAt !== null || part.fulfilment === 'shipped' || delivered;
  const ready = part.readyAt !== null || shipped;
  const steps = pickup
    ? ([
        { key: 'ready-pickup', done: ready, at: part.readyAt },
        { key: 'collected', done: delivered, at: part.deliveredAt },
      ] as const)
    : ([
        { key: 'ready', done: ready, at: part.readyAt },
        { key: 'shipped', done: shipped, at: part.shippedAt },
        { key: 'delivered', done: delivered, at: part.deliveredAt },
      ] as const);
  return (
    <ol
      aria-label={t('detail.steps')}
      className={`grid gap-2 ${pickup ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}
    >
      {steps.map((step) => (
        <li
          key={step.key}
          className={`rounded-md border px-3 py-2 ${step.done ? 'border-line bg-surface' : 'border-line-row text-fg-muted'}`}
        >
          <div className="font-medium">{t(`step.${step.key}`)}</div>
          <div className="text-sm">
            {step.done
              ? step.at === null
                ? t('detail.step-done')
                : formatInstant(step.at, locale)
              : t('detail.step-pending')}
          </div>
        </li>
      ))}
    </ol>
  );
}

function SellerPartCard({
  part,
  paid,
  index,
  count,
}: {
  readonly part: SellerPart;
  readonly paid: boolean;
  readonly index: number;
  readonly count: number;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const rows: readonly DataListRow[] = [
    { label: t('field.seller-account'), value: <FullId id={part.sellerId} /> },
    { label: t('field.fulfilment'), value: <FulfilmentBadge fulfilment={part.fulfilment} /> },
    {
      label: t('field.delivery-method'),
      value: t(`delivery-method.${known(part.deliveryMethod, DELIVERY_METHODS)}`),
    },
    ...(part.deliveryWindowStart === null || part.deliveryWindowEnd === null
      ? []
      : [
          {
            label: t('field.delivery-window'),
            value: `${formatInstant(part.deliveryWindowStart, locale)} \u2013 ${formatInstant(part.deliveryWindowEnd, locale)}`,
          },
        ]),
    { label: t('field.carrier'), value: part.carrier },
    { label: t('field.tracking'), value: part.trackingRef },
  ];
  return (
    <Card title={part.storeName?.trim() || t('detail.seller', { id: shortId(part.sellerId) })}>
      <p className="text-sm text-fg-muted">{t('detail.part-of', { index, count })}</p>
      {part.deliveryAttention === null ? null : (
        <Banner tone="attention">
          {t('detail.attention.title')}{' '}
          {t(`detail.attention.${attentionKey(part.deliveryAttention)}`)}
        </Banner>
      )}
      {paid ? <FulfilmentSteps part={part} /> : null}
      <DataList rows={rows} missing={t('none')} />
      <ul className="flex flex-col divide-y divide-line-row border-t border-line">
        {part.lines.map((line) => (
          <LineRow key={line.lineId} line={line} />
        ))}
      </ul>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-line pt-3">
        <dt className="text-fg-muted">{t('field.subtotal')}</dt>
        <dd className="text-end tabular-nums">{formatMoney(part.subtotal, locale)}</dd>
        <dt className="text-fg-muted">{t('field.shipping')}</dt>
        <dd className="text-end tabular-nums">{formatMoney(part.shipping, locale)}</dd>
        <dt className="text-fg-muted">{t(`field.${taxLabel(part)}`)}</dt>
        <dd className="text-end tabular-nums">
          {part.tax === null ? t('tax.not-recorded') : formatMoney(part.tax, locale)}
        </dd>
        <dt className="font-semibold">{t('field.part-total')}</dt>
        <dd className="text-end font-semibold tabular-nums">{formatMoney(part.total, locale)}</dd>
      </dl>
    </Card>
  );
}

function attentionKey(
  value: string,
): 'no-carrier' | 'carrier-unknown' | 'cancel-unknown' | 'other' {
  return value === 'no-carrier' || value === 'carrier-unknown' || value === 'cancel-unknown'
    ? value
    : 'other';
}

/** Whether the part's tax is inside its prices, added on top of them, or a mix of both. */
function taxLabel(part: SellerPart): 'tax-included' | 'tax-added' | 'tax' {
  if (part.lines.every((line) => line.taxInclusive)) return 'tax-included';
  if (part.lines.every((line) => !line.taxInclusive)) return 'tax-added';
  return 'tax';
}

function LineRow({ line }: { readonly line: OrderLine }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 first:pt-3">
      <div className="min-w-0">
        <div className="font-medium break-words" title={line.variantId}>
          {line.productName?.trim() || <FallbackId id={line.offerId} />}
          {line.variantLabel?.trim() ? ` · ${line.variantLabel}` : ''}
        </div>
        <div className="text-sm text-fg-muted">
          {t('line.variant', { id: shortId(line.variantId) })}
          {' · '}
          {t('line.offer', { id: shortId(line.offerId) })}
          {' · '}
          {t('line.quantity', {
            quantity: line.quantity,
            price: formatMoney(line.unitPrice, locale),
          })}
          {line.taxInclusive ? ` · ${t('line.tax-included')}` : ''}
          {line.tax !== null && line.taxRateBps !== null
            ? ` · ${t('line.tax', {
                rate: numberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
                  line.taxRateBps / 10_000,
                ),
                amount: formatMoney(line.tax, locale),
              })}`
            : ''}
        </div>
      </div>
      <div className="font-medium tabular-nums">{formatMoney(line.lineAmount, locale)}</div>
    </li>
  );
}
