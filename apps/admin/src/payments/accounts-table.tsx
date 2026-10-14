import { useTranslations } from 'next-intl';
import { formatInstant } from '../sellers/format.ts';
import { AccountStatusBadge } from './status-badge.tsx';
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
                className={`px-4 py-3 font-medium ${col === 'requirements' ? 'text-end' : ''}`}
              >
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => (
            <tr key={row.sellerId}>
              <td className="min-w-48 max-w-72 px-4 py-3">
                <div className="break-words font-medium text-fg">
                  <a className="text-link underline" href={`/payout-accounts/${row.sellerId}`}>
                    {row.sellerName ?? t('unnamed')}
                  </a>
                </div>
                <div className="text-fg-muted" title={row.sellerId}>
                  {shortId(row.sellerId)}
                </div>
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <AccountStatusBadge status={row.status} />
              </td>
              <td className="px-4 py-3">{t(row.ready ? 'yes' : 'no')}</td>
              <td className="px-4 py-3 text-end tabular-nums">
                {row.requirementsDue}
                {row.requirementsPastDue ? (
                  <div className="text-critical-fg">{t('past-due')}</div>
                ) : null}
              </td>
              <td className="px-4 py-3">{formatInstant(row.coolingOffUntil)}</td>
              <td className="px-4 py-3">{t(row.payoutsPaused ? 'yes' : 'no')}</td>
              <td className="px-4 py-3">{formatInstant(row.lastReadAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
