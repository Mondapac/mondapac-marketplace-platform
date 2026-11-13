import { Badge, CARD_TABLE } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { shortId, statusOf, TONE } from './status.ts';
import { DEFAULT_COLUMNS, type OrderColumn } from './orders-columns.ts';
import type { SellerOrderView } from './types.ts';

type Head = OrderColumn | 'order';
const NUMERIC = new Set<Head>(['items', 'total']);
/** The width of each column from 1024 px; the order reference is always the first. */
const WIDTH: Readonly<Record<Head, string>> = {
  order: '',
  status: 'w-36',
  paid: 'w-48',
  items: 'w-24',
  total: 'w-32',
};

/**
 * The paid orders as a table from 1024 px and as labelled cards below it: reference (the link
 * to the order), paid date, number of items, total and fulfilment. Money and counts end-align.
 */
export function OrdersTable({
  orders,
  columns = DEFAULT_COLUMNS,
}: {
  readonly orders: readonly SellerOrderView[];
  readonly columns?: readonly OrderColumn[];
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  const label = (col: Head) => t(`col.${col}`);
  const heads: readonly Head[] = ['order', ...columns];
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-180 lg:table-fixed`}>
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
                {columns.map((column) => {
                  switch (column) {
                    case 'status':
                      return (
                        <td key={column} className={CARD_TABLE.corner}>
                          <Badge tone={TONE[statusOf(order)]}>
                            {t(`status.${statusOf(order)}`)}
                          </Badge>
                        </td>
                      );
                    case 'paid':
                      return (
                        <td key={column} className={CARD_TABLE.labelled} data-label={label('paid')}>
                          <time dateTime={order.paidAt}>
                            {shortInstant(order.paidAt, locale, zone)}
                          </time>
                        </td>
                      );
                    case 'items':
                      return (
                        <td
                          key={column}
                          className={`${CARD_TABLE.labelled} tabular-nums lg:text-end`}
                          data-label={label('items')}
                        >
                          {count}
                        </td>
                      );
                    case 'total':
                      return (
                        <td
                          key={column}
                          className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                          data-label={label('total')}
                        >
                          {formatMinor(order.total.amount, order.total.currency, locale)}
                        </td>
                      );
                  }
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
