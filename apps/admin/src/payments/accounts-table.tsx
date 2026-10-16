import { CARD_TABLE } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { shortId } from '../shared/short-id.ts';
import { AccountStatusBadge, FlagBadge } from './status-badge.tsx';
import type { ConnectedAccountRow } from './types.ts';

const COLUMNS = [
  'seller',
  'status',
  'ready',
  'requirements',
  'cooling-off',
  'paused',
  'last-read',
] as const;

const DAY_TIME = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const DAY_TIME_YEAR = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** A compact UTC instant for a table cell ("14 Oct, 3:30 am"); the year only when not this one. */
function shortInstant(iso: string | null): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return (sameYear ? DAY_TIME : DAY_TIME_YEAR).format(date);
}

/** The connected accounts of one page: seller, status, readiness, requirements and the wait. */
export function AccountsTable({ rows }: { readonly rows: readonly ConnectedAccountRow[] }) {
  const t = useTranslations('payments.accounts');
  const label = (col: (typeof COLUMNS)[number]) =>
    t(col === 'cooling-off' || col === 'last-read' ? `col.${col}-utc` : `col.${col}`);
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
                className={`whitespace-nowrap px-4 py-3 font-medium ${col === 'requirements' ? 'text-end' : ''}`}
              >
                {label(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => (
            <tr key={row.sellerId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} lg:min-w-40 lg:max-w-56`}>
                <div className="break-words font-medium text-fg">
                  <a className="text-link underline" href={`/payout-accounts/${row.sellerId}`}>
                    {row.sellerName ?? t('unnamed')}
                  </a>
                </div>
                <div className="text-fg-muted" title={row.sellerId}>
                  {shortId(row.sellerId)}
                </div>
              </td>
              <td className={CARD_TABLE.corner}>
                <AccountStatusBadge status={row.status} />
              </td>
              <td className={CARD_TABLE.labelled} data-label={label('ready')}>
                <FlagBadge on={row.ready} tone="success" />
              </td>
              <td
                className={`${CARD_TABLE.labelled} tabular-nums lg:text-end`}
                data-label={label('requirements')}
              >
                <div>
                  {row.requirementsDue}
                  {row.requirementsPastDue ? (
                    <div className="text-critical-fg">{t('past-due')}</div>
                  ) : null}
                </div>
              </td>
              <td
                className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
                data-label={label('cooling-off')}
              >
                {shortInstant(row.coolingOffUntil)}
              </td>
              <td className={CARD_TABLE.labelled} data-label={label('paused')}>
                <FlagBadge on={row.payoutsPaused} tone="attention" />
              </td>
              <td
                className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
                data-label={label('last-read')}
              >
                {shortInstant(row.lastReadAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
