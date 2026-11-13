import { CARD_TABLE, EmailText } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../pricing/format.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { FallbackId } from './fallback-id.tsx';
import { DEFAULT_COLUMNS, type OrderColumn } from './orders-columns.ts';
import { OrderStatusBadge } from './status-badge.tsx';
import type { AdminOrder, OrderCustomer } from './types.ts';

/** The width of each column from 1024 px; the order reference is always the first. */
const WIDTH: Readonly<Record<OrderColumn | 'order', string>> = {
  order: 'w-37',
  status: 'w-36',
  placed: 'w-36',
  paid: 'w-36',
  customer: 'w-48',
  sellers: 'w-32',
  total: 'w-20',
};
const END: readonly string[] = ['total'];

/**
 * The orders of one page: the reference, then the columns the admin chose (status, dates, customer,
 * seller count and total) in their order. Times are in `zone`, the zone of the day filters, which
 * the list names once above the table. Below 1024 px each order is a labelled card.
 */
export function OrdersTable({
  rows,
  columns = DEFAULT_COLUMNS,
  zone,
}: {
  readonly rows: readonly AdminOrder[];
  readonly columns?: readonly OrderColumn[];
  readonly zone: string;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const heads: readonly (OrderColumn | 'order')[] = ['order', ...columns];

  const cell = (order: AdminOrder, column: OrderColumn) => {
    switch (column) {
      case 'status':
        return (
          <td key={column} className={CARD_TABLE.corner}>
            <OrderStatusBadge status={order.status} />
          </td>
        );
      case 'placed':
        return (
          <td
            key={column}
            className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
            data-label={t('col.placed')}
          >
            {shortInstantInZone(order.createdAt, locale, zone, true)}
          </td>
        );
      case 'paid':
        return (
          <td
            key={column}
            className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
            data-label={t('col.paid')}
          >
            {shortInstantInZone(order.confirmedAt, locale, zone, true)}
          </td>
        );
      case 'customer':
        return (
          <td key={column} className={CARD_TABLE.labelled} data-label={t('col.customer')}>
            <CustomerCell customer={order.customer} accountId={order.accountId} />
          </td>
        );
      case 'sellers':
        return (
          <td key={column} className={CARD_TABLE.labelled} data-label={t('col.sellers')}>
            <SellerNames order={order} />
          </td>
        );
      case 'total':
        return (
          <td
            key={column}
            className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
            data-label={t('col.total')}
          >
            {formatMoney(order.total, locale)}
          </td>
        );
    }
  };

  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:table-fixed`}>
        <caption className="sr-only">{t('title')}</caption>
        <colgroup className="max-lg:hidden">
          {heads.map((head) => (
            <col key={head} className={WIDTH[head]} />
          ))}
        </colgroup>
        <thead className={CARD_TABLE.head}>
          <tr>
            {heads.map((col) => (
              <th
                key={col}
                scope="col"
                className={`px-4 py-3 font-medium whitespace-nowrap ${END.includes(col) ? 'text-end' : ''}`}
              >
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((order) => (
            <tr key={order.orderId} className={CARD_TABLE.row}>
              <td className={CARD_TABLE.cell}>
                <a
                  className="font-medium text-link underline lg:whitespace-nowrap"
                  href={`/orders/${encodeURIComponent(order.orderId)}`}
                  title={order.orderId}
                >
                  {t('reference', { id: shortId(order.orderId) })}
                </a>
              </td>
              {columns.map((column) => cell(order, column))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Name with the email below it; the email alone when no name; the short id when neither. */
function CustomerCell({
  customer,
  accountId,
}: {
  readonly customer: OrderCustomer | null;
  readonly accountId: string;
}) {
  if (customer === null) return <FallbackId id={accountId} />;
  const name = customer.displayName?.trim() || null;
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" title={accountId}>
      {name === null ? (
        <EmailText address={customer.email} />
      ) : (
        <>
          <div className="font-medium">{name}</div>
          <div className="text-sm text-fg-muted">
            <EmailText address={customer.email} />
          </div>
        </>
      )}
    </div>
  );
}

/** One line per seller part: the shop name, or the short id when the name is unknown. */
function SellerNames({ order }: { readonly order: AdminOrder }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1 break-words">
      {order.sellerOrders.map((part) => (
        <li key={part.sellerId} title={part.sellerId}>
          {part.storeName?.trim() || <FallbackId id={part.sellerId} />}
        </li>
      ))}
    </ul>
  );
}
