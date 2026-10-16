import { Badge, CARD_TABLE } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { shortId, TONE } from './status.ts';
import type { SellerOrderView } from './types.ts';

const COLUMNS = ['order', 'status', 'paid', 'items', 'total'] as const;
const NUMERIC = new Set<(typeof COLUMNS)[number]>(['items', 'total']);

/**
 * The paid orders as a table from 1024 px and as labelled cards below it: reference (the link
 * to the order), paid date, number of items, total and fulfilment. Money and counts end-align.
 */
export function OrdersTable({ orders }: { readonly orders: readonly SellerOrderView[] }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const label = (col: (typeof COLUMNS)[number]) => t(`col.${col}`);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-180 lg:table-fixed`}>
        <caption className="sr-only">{t('title')}</caption>
        <colgroup className="max-lg:hidden">
          <col />
          <col className="w-36" />
          <col className="w-48" />
          <col className="w-24" />
          <col className="w-32" />
        </colgroup>
        <thead className={CARD_TABLE.head}>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={`px-4 py-3 font-medium ${NUMERIC.has(col) ? 'text-end' : ''}`}
              >
                {label(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {orders.map((order) => {
            const count = order.lines.reduce((sum, line) => sum + line.quantity, 0);
            return (
              <tr key={order.sellerOrderId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} break-words font-medium`}>
                  <a className="text-link underline" href={`/orders/${order.sellerOrderId}`}>
                    {t('ref', { id: shortId(order.sellerOrderId) })}
                  </a>
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={TONE[order.fulfilment]}>{t(`status.${order.fulfilment}`)}</Badge>
                </td>
                <td
                  className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
                  data-label={label('paid')}
                >
                  {shortInstant(order.paidAt, locale)}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} tabular-nums lg:text-end`}
                  data-label={label('items')}
                >
                  {count}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                  data-label={label('total')}
                >
                  {formatMinor(order.total.amount, order.total.currency, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
