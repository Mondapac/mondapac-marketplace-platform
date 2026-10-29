import { Badge, Button, CARD_TABLE } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { formatMinor } from '../wallet/money.ts';
import { StateBadge } from './state-badge.tsx';
import { bankWaitUntil, type PayoutRow } from './types.ts';

const COLUMNS = ['payout', 'seller', 'amount', 'state', 'why', 'slot', 'actions'] as const;

/**
 * One page of payouts: a table from 1024 px, labelled cards below. A payout that waits for an
 * admin has an approve button, except one in the waiting period after a bank change: that row
 * shows the reason as a badge and has no button (a disabled button would hide the reason).
 */
export function PayoutsTable({
  rows,
  zone,
  now,
  canApprove,
  busy,
  onApprove,
}: {
  readonly rows: readonly PayoutRow[];
  readonly zone: string;
  readonly now: number;
  readonly canApprove: boolean;
  /** An approval is running: the buttons wait. */
  readonly busy: boolean;
  readonly onApprove: (row: PayoutRow) => void;
}) {
  const t = useTranslations('payouts');
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
          {rows.map((row) => {
            const wait = row.state === 'awaiting-approval' ? bankWaitUntil(row, now) : null;
            const name = row.storeName ?? t('unnamed', { id: shortId(row.sellerId) });
            return (
              <tr key={row.payoutId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} lg:min-w-28`}>
                  <a
                    className="font-medium text-link underline"
                    href={`/payouts/${row.payoutId}`}
                    title={row.payoutId}
                  >
                    {t('ref', { id: shortId(row.payoutId) })}
                  </a>
                </td>
                <td className={CARD_TABLE.corner}>
                  <StateBadge state={row.state} />
                </td>
                <td
                  className={`${CARD_TABLE.labelled} lg:min-w-40 lg:max-w-56`}
                  data-label={t('col.seller')}
                >
                  <a className="break-words text-link underline" href={`/sellers/${row.sellerId}`}>
                    {name}
                  </a>
                </td>
                <td
                  className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:text-end`}
                  data-label={t('col.amount')}
                >
                  <span>
                    {formatMinor(row.transfer.amountMinor, row.transfer.currency, locale)}
                  </span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.why')}>
                  <span>
                    {row.approvalMode === 'AUTO' || row.approvalReason === null
                      ? t('why.auto')
                      : t(`why.${row.approvalReason}`)}
                  </span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.slot')}>
                  <span>{shortInstantInZone(row.slotAt, locale, zone)}</span>
                </td>
                <td className={`${CARD_TABLE.labelled} max-lg:!block`} data-label="">
                  {row.state !== 'awaiting-approval' || !canApprove ? null : wait !== null ? (
                    <Badge tone="attention">
                      {t('bank-wait', { until: shortInstantInZone(wait, locale, zone) })}
                    </Badge>
                  ) : (
                    <Button disabled={busy} onClick={() => onApprove(row)}>
                      {t('review')}
                      <span className="sr-only"> {t('approve-for', { name })}</span>
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
