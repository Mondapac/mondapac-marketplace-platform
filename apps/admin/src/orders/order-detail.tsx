import { BackLink, Banner, Card, DataList, EmailText, type DataListRow } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../pricing/format.ts';
import { known } from '../sellers/format.ts';
import { formatInstant } from '../shared/format.ts';
import { numberFormat } from '../shared/intl.ts';
import { shortId } from '../shared/short-id.ts';
import { FallbackId, FullId } from './fallback-id.tsx';
import { FulfilmentBadge, OrderStatusBadge } from './status-badge.tsx';
import {
  CANCEL_REASONS,
  PAYMENT_STATES,
  type AdminOrder,
  type OrderLine,
  type SellerPart,
} from './types.ts';

/** One order for support and oversight: summary, then each seller's part. Read-only. */
export function OrderDetail({ order }: { readonly order: AdminOrder }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const rows: readonly DataListRow[] = [
    { label: t('field.status'), value: <OrderStatusBadge status={order.status} /> },
    ...(order.cancelReason === null
      ? []
      : [
          {
            label: t('field.cancel-reason'),
            value: t(`cancel-reason.${known(order.cancelReason, CANCEL_REASONS)}`),
          },
        ]),
    {
      label: t('field.payment'),
      value: t(`payment.${known(order.paymentState, PAYMENT_STATES)}`),
    },
    { label: t('field.placed'), value: formatInstant(order.createdAt, locale) },
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
    ...(order.customer === null
      ? []
      : [
          {
            label: t('field.customer-name'),
            value: order.customer.displayName?.trim() || null,
          },
          {
            label: t('field.customer-email'),
            value: <EmailText address={order.customer.email} />,
          },
        ]),
    { label: t('field.customer'), value: <FullId id={order.accountId} /> },
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
    <div className="flex flex-col gap-4">
      <BackLink href="/orders" label={t('detail.back')} />
      <div>
        <h1 className="text-2xl font-semibold break-words">
          {t('reference', { id: shortId(order.orderId) })}
        </h1>
        <p className="mt-1 text-sm text-fg-muted break-all">{order.orderId}</p>
      </div>
      <Card title={t('detail.summary')}>
        <DataList rows={rows} missing={t('none')} />
      </Card>
      <h2 className="text-lg font-semibold">
        {t('detail.parts', { count: order.sellerOrders.length })}
      </h2>
      {order.sellerOrders.length === 0 ? (
        <Banner tone="info">{t('detail.no-parts')}</Banner>
      ) : (
        order.sellerOrders.map((part) => <SellerPartCard key={part.sellerId} part={part} />)
      )}
    </div>
  );
}

function SellerPartCard({ part }: { readonly part: SellerPart }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const rows: readonly DataListRow[] = [
    { label: t('field.seller-account'), value: <FullId id={part.sellerId} /> },
    { label: t('field.fulfilment'), value: <FulfilmentBadge fulfilment={part.fulfilment} /> },
    { label: t('field.carrier'), value: part.carrier },
    { label: t('field.tracking'), value: part.trackingRef },
    { label: t('field.shipped'), value: part.shippedAt && formatInstant(part.shippedAt, locale) },
    {
      label: t('field.delivered'),
      value: part.deliveredAt && formatInstant(part.deliveredAt, locale),
    },
  ];
  return (
    <Card title={part.storeName?.trim() || t('detail.seller', { id: shortId(part.sellerId) })}>
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
