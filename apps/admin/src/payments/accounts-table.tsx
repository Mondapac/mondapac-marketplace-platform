import { useTranslations } from 'next-intl';
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

/** The last 8 characters of the seller id, enough to tell two sellers apart in a list. */
const shortId = (id: string): string => id.slice(-8).toUpperCase();

/** The connected accounts of one page: seller, status, readiness, requirements and the wait. */
export function AccountsTable({ rows }: { readonly rows: readonly ConnectedAccountRow[] }) {
  const t = useTranslations('payments.accounts');
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-200 text-start text-sm">
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={`whitespace-nowrap px-3 py-3 font-medium ${col === 'requirements' ? 'text-end' : ''}`}
              >
                {t(col === 'cooling-off' || col === 'last-read' ? `col.${col}-utc` : `col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => (
            <tr key={row.sellerId}>
              <td className="min-w-40 max-w-56 px-3 py-3">
                <div className="break-words font-medium text-fg">
                  <a className="text-link underline" href={`/payout-accounts/${row.sellerId}`}>
                    {row.sellerName ?? t('unnamed')}
                  </a>
                </div>
                <div className="text-fg-muted" title={row.sellerId}>
                  {shortId(row.sellerId)}
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-3">
                <AccountStatusBadge status={row.status} />
              </td>
              <td className="whitespace-nowrap px-3 py-3">
                <FlagBadge on={row.ready} tone="success" />
              </td>
              <td className="px-3 py-3 text-end tabular-nums">
                {row.requirementsDue}
                {row.requirementsPastDue ? (
                  <div className="text-critical-fg">{t('past-due')}</div>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-3">{shortInstant(row.coolingOffUntil)}</td>
              <td className="whitespace-nowrap px-3 py-3">
                <FlagBadge on={row.payoutsPaused} tone="attention" />
              </td>
              <td className="whitespace-nowrap px-3 py-3">{shortInstant(row.lastReadAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
