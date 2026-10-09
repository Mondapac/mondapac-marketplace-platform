import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { formatInstant, known } from './format.ts';
import { KINDS, STATUSES, type SellerRow } from './types.ts';

const TONE: Record<string, BadgeTone> = {
  approved: 'success',
  'awaiting-review': 'attention',
  'changes-needed': 'attention',
  suspended: 'critical',
  'file-check-needed': 'critical',
  'outside-service-area': 'critical',
};

/** The rows of one tab: store, status, kind of submission, area and dates. */
export function SellersTable({ rows }: { readonly rows: readonly SellerRow[] }) {
  const t = useTranslations('sellers.list');
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-start text-sm">
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            {['store', 'status', 'kind', 'area', 'submitted', 'changed'].map((col) => (
              <th key={col} scope="col" className="px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => {
            const status = known(row.status, STATUSES);
            return (
              <tr key={row.sellerId}>
                <td className="break-words px-4 py-3">
                  <div className="font-medium text-fg">{row.storeName ?? t('unnamed')}</div>
                  {row.slug === null ? null : <div className="text-fg-muted">{row.slug}</div>}
                  {row.origin === 'invitation' ? (
                    <div className="text-fg-muted">{t('invited')}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  {status === 'hidden' ? (
                    <span className="text-fg-muted">-</span>
                  ) : (
                    <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.kind === null ? '-' : t(`kind.${known(row.kind, KINDS)}`)}
                </td>
                <td className="px-4 py-3">{row.serviceAreaCode ?? '-'}</td>
                <td className="px-4 py-3">{formatInstant(row.submittedAt)}</td>
                <td className="px-4 py-3">{formatInstant(row.lastChangedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
