import { CARD_TABLE } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../pricing/format.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { OrderStatusBadge } from './status-badge.tsx';
import type { AdminOrder } from './types.ts';

const COLUMNS = ['order', 'status', 'placed', 'paid', 'customer', 'sellers', 'total'] as const;
const END: readonly string[] = ['sellers', 'total'];

/** The orders of one page: reference, status, dates, customer, seller count and total. */
export function OrdersTable({ rows }: { readonly rows: readonly AdminOrder[] }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-200 lg:table-fixed`}>
        <caption className="sr-only">{t('title')}</caption>
        <colgroup className="max-lg:hidden">
          <col />
          <col className="w-40" />
          <col className="w-36" />
          <col className="w-36" />
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-32" />
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
                <span title={order.accountId}>{shortId(order.accountId)}</span>
              </td>
              <td
                className={`${CARD_TABLE.labelled} tabular-nums lg:text-end`}
                data-label={t('col.sellers')}
              >
                {order.sellerOrders.length}
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
