import { Badge, CARD_TABLE, EmailText, type BadgeTone } from '@mondapac/ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { areaName, known } from './format.ts';
import { When } from './when.tsx';
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
  empty,
}: {
  readonly rows: readonly SellerRow[];
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /** Only for an admin who may see identity's state; the column is left out otherwise. */
  readonly showOwner: boolean;
  /** Rows link to the review page only for an actor who may open it. */
  readonly canReview: boolean;
}) {
  const t = useTranslations('sellers.list');
  const cols = showOwner
    ? ['store', 'owner', 'status', 'area', 'submitted', 'changed']
    : ['store', 'status', 'area', 'submitted', 'changed'];
  // From 1024 px a table; below it (phones and tablets, where seven columns do not fit) each row is a card with labelled lines (like the Team table).
  const { cell, labelled } = CARD_TABLE;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} ${showOwner ? 'lg:min-w-200' : 'lg:min-w-160'}`}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {cols.map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.length === 0 && empty !== undefined ? (
            <tr className="max-lg:block">
              <td colSpan={cols.length} className="max-lg:block">
                {empty}
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const status = known(row.status, STATUSES);
            return (
              <tr key={row.sellerId} className={CARD_TABLE.row}>
                <td className={`${cell} lg:min-w-(--mp-size-data-label)`}>
                  <div className="min-w-0">
                    <div className="break-words font-medium text-fg">
                      {canReview ? (
                        // A plain link: opening the page reads business details and is audited.
                        <a className="text-link underline" href={`/sellers/${row.sellerId}`}>
                          {row.storeName ?? t('unnamed')}
                        </a>
                      ) : (
                        (row.storeName ?? t('unnamed'))
                      )}
                    </div>
                    {row.slug === null ? null : (
                      <div className="break-all text-xs text-fg-muted">{row.slug}</div>
                    )}
                    {row.origin === 'invitation' ? (
                      <div className="text-xs text-fg-muted">{t('invited')}</div>
                    ) : null}
                  </div>
                </td>
                {showOwner ? (
                  <td
                    className={`${labelled} lg:min-w-(--mp-size-data-label)`}
                    data-label={t('col.owner')}
                  >
                    {/* The owner's name and address: escaped text only (personal data). */}
                    {row.owner === null ? (
                      <span className="text-fg-muted">{t('not-given')}</span>
                    ) : (
                      <span className="block min-w-0">
                        <span className="block break-words text-fg">
                          {row.owner.displayName ?? t('owner-unnamed')}
                        </span>
                        <span className="block break-words text-fg-muted">
                          <EmailText address={row.owner.email} />
                        </span>
                      </span>
                    )}
                  </td>
                ) : null}
                {/* On a phone the status sits beside the name, where the eye starts. */}
                {/* The kind of submission sits under the status it explains. */}
                <td className={CARD_TABLE.corner}>
                  {status === 'hidden' ? (
                    <span className="text-fg-muted">-</span>
                  ) : (
                    <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
                  )}
                  {row.kind === null ? null : (
                    <span className="mt-1 block text-xs text-fg-muted">
                      {t(`kind.${known(row.kind, KINDS)}`)}
                    </span>
                  )}
                </td>
                <td className={`${labelled} lg:whitespace-nowrap`} data-label={t('col.area')}>
                  {areaName(row.serviceAreaCode) ?? (
                    <span className="text-fg-muted">{t('not-given')}</span>
                  )}
                </td>
                <td className={labelled} data-label={t('col.submitted')}>
                  <When iso={row.submittedAt} missing={t('not-given')} />
                </td>
                <td className={labelled} data-label={t('col.changed')}>
                  <When iso={row.lastChangedAt} missing={t('not-given')} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
