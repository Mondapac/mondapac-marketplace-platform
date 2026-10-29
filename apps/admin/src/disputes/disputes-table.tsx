import { CARD_TABLE } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { EvidenceDueText } from './evidence-due.tsx';
import { reasonText } from './evidence.ts';
import { MoneyStateBadge } from './money-state-badge.tsx';
import type { DisputeRow } from './types.ts';

const COLUMNS = ['case', 'money', 'sellers', 'reason', 'evidence', 'amount'] as const;

/** One page of cases: a table from 1024 px, labelled cards below. */
export function DisputesTable({
  rows,
  zone,
  now,
}: {
  readonly rows: readonly DisputeRow[];
  readonly zone: string;
  readonly now: number;
}) {
  const t = useTranslations('disputes');
  const locale = useLocale();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={`whitespace-nowrap px-4 py-3 font-medium ${col === 'amount' ? 'text-end' : ''}`}
              >
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => (
            <tr key={row.disputeId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} lg:min-w-32`}>
                <a
                  className="font-medium text-link underline"
                  href={`/disputes/${row.disputeId}`}
                  title={row.orderId}
                >
                  {t('case-ref', { id: shortId(row.orderId) })}
                </a>
              </td>
              <td className={CARD_TABLE.corner}>
                <MoneyStateBadge state={row.moneyState} />
              </td>
              <td
                className={`${CARD_TABLE.labelled} lg:min-w-40 lg:max-w-56`}
                data-label={t('col.sellers')}
              >
                <span className="break-words">
                  {row.sellers.length === 0
                    ? t('sellers-none')
                    : row.sellers
                        .map(
                          (seller) =>
                            seller.storeName ?? t('unnamed', { id: shortId(seller.sellerId) }),
                        )
                        .join(', ')}
                </span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.reason')}>
                <span>{reasonText(row.reason)}</span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.evidence')}>
                <EvidenceDueText iso={row.evidenceDueBy} zone={zone} now={now} />
              </td>
              <td
                className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                data-label={t('col.amount')}
              >
                <span>{formatMinor(row.amount.amountMinor, row.amount.currency, locale)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
