import { CARD_TABLE, EmailText } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../pricing/format.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { OrderStatusBadge } from './status-badge.tsx';
import type { AdminOrder, OrderCustomer } from './types.ts';

const COLUMNS = ['order', 'status', 'placed', 'paid', 'customer', 'sellers', 'total'] as const;
const END: readonly string[] = ['total'];

/** The orders of one page: reference, status, dates, customer, seller count and total. */
export function OrdersTable({ rows }: { readonly rows: readonly AdminOrder[] }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-240 lg:table-fixed`}>
        <caption className="sr-only">{t('title')}</caption>
        <colgroup className="max-lg:hidden">
          <col />
          <col className="w-40" />
          <col className="w-36" />
          <col className="w-36" />
          <col className="w-44" />
          <col className="w-36" />
          <col className="w-24" />
        </colgroup>
        <thead className={CARD_TABLE.head}>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={`px-4 py-3 font-medium ${END.includes(col) ? 'text-end' : ''}`}
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
                  className="break-words font-medium text-link underline"
                  href={`/orders/${encodeURIComponent(order.orderId)}`}
                  title={order.orderId}
                >
                  {t('reference', { id: shortId(order.orderId) })}
                </a>
              </td>
              <td className={CARD_TABLE.corner}>
                <OrderStatusBadge status={order.status} />
              </td>
              <td
                className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
                data-label={t('col.placed')}
              >
                {shortInstant(order.createdAt, locale)}
              </td>
              <td
                className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
                data-label={t('col.paid')}
              >
                {shortInstant(order.confirmedAt, locale)}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.customer')}>
                <CustomerCell customer={order.customer} accountId={order.accountId} />
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.sellers')}>
                <SellerNames order={order} />
              </td>
              <td
                className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                data-label={t('col.total')}
              >
                {formatMoney(order.total, locale)}
              </td>
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
  if (customer === null) return <span title={accountId}>{shortId(accountId)}</span>;
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
          {part.storeName?.trim() || shortId(part.sellerId)}
        </li>
      ))}
    </ul>
  );
}
