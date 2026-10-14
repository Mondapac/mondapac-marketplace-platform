import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { formatInstant, known } from './format.ts';
import { KINDS, STATUSES, type SellerRow } from './types.ts';

const TONE: Record<string, BadgeTone> = {
  approved: 'success',
  'awaiting-review': 'attention',
  'changes-needed': 'attention',
  'not-approved': 'critical',
  suspended: 'critical',
  'file-check-needed': 'critical',
  'outside-service-area': 'critical',
};

/** The rows of one tab: store, owner, status, kind of submission, area and dates. */
export function SellersTable({
  rows,
  canReview,
  showOwner,
}: {
  readonly rows: readonly SellerRow[];
  /** Only for an admin who may see identity's state; the column is left out otherwise. */
  readonly showOwner: boolean;
  /** Rows link to the review page only for an actor who may open it. */
  readonly canReview: boolean;
}) {
  const t = useTranslations('sellers.list');
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className={`w-full text-start text-sm ${showOwner ? 'min-w-200' : 'min-w-160'}`}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            {(showOwner
              ? ['store', 'owner', 'status', 'kind', 'area', 'submitted', 'changed']
              : ['store', 'status', 'kind', 'area', 'submitted', 'changed']
            ).map((col) => (
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
                  <div className="font-medium text-fg">
                    {canReview ? (
                      // A plain link: opening the page reads business details and is audited.
                      <a className="text-link underline" href={`/sellers/${row.sellerId}`}>
                        {row.storeName ?? t('unnamed')}
                      </a>
                    ) : (
                      (row.storeName ?? t('unnamed'))
                    )}
                  </div>
                  {row.slug === null ? null : <div className="text-fg-muted">{row.slug}</div>}
                  {row.origin === 'invitation' ? (
                    <div className="text-fg-muted">{t('invited')}</div>
                  ) : null}
                </td>
                {showOwner ? (
                  <td className="min-w-64 max-w-80 px-4 py-3">
                    {/* The owner's name and address: escaped text only (personal data). */}
                    {row.owner === null ? (
                      <span className="text-fg-muted">-</span>
                    ) : (
                      <>
                        <div className="break-words text-fg">
                          {row.owner.displayName ?? t('owner-unnamed')}
                        </div>
                        <div className="text-fg-muted wrap-anywhere">{row.owner.email}</div>
                      </>
                    )}
                  </td>
                ) : null}
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
                <td className="whitespace-nowrap px-4 py-3">{row.serviceAreaCode ?? '-'}</td>
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
