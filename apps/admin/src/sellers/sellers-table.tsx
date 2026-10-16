import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { areaName, formatInstant, known } from './format.ts';
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
  const cols = showOwner
    ? ['store', 'owner', 'status', 'area', 'submitted', 'changed']
    : ['store', 'status', 'area', 'submitted', 'changed'];
  // From 1024 px a table; below it (phones and tablets, where seven columns do not fit) each row is a card with labelled lines (like the Team table).
  const cell = 'px-4 py-3 align-top max-lg:p-0';
  const labelled = `${cell} max-lg:col-span-2 ${LABELLED}`;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table
        className={`w-full text-start text-sm max-lg:block ${showOwner ? 'lg:min-w-200' : 'lg:min-w-160'}`}
      >
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-muted text-fg-muted max-lg:sr-only">
          <tr>
            {cols.map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row max-lg:block">
          {rows.map((row) => {
            const status = known(row.status, STATUSES);
            return (
              <tr
                key={row.sellerId}
                className="max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:items-start max-lg:gap-x-3 max-lg:gap-y-2 max-lg:p-4"
              >
                <td className={`${cell} min-w-48`}>
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
                  <td className={`${labelled} lg:min-w-64`} data-label={t('col.owner')}>
                    {/* The owner's name and address: escaped text only (personal data). */}
                    {row.owner === null ? (
                      <span className="text-fg-muted">-</span>
                    ) : (
                      <span className="block min-w-0">
                        <span className="block break-words text-fg">
                          {row.owner.displayName ?? t('owner-unnamed')}
                        </span>
                        <span className="block break-words text-fg-muted">
                          <Email address={row.owner.email} />
                        </span>
                      </span>
                    )}
                  </td>
                ) : null}
                {/* On a phone the status sits beside the name, where the eye starts. */}
                {/* The kind of submission sits under the status it explains. */}
                <td className={`${cell} max-lg:col-start-2 max-lg:row-start-1 max-lg:text-end`}>
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
                  {areaName(row.serviceAreaCode)}
                </td>
                <td className={labelled} data-label={t('col.submitted')}>
                  <When iso={row.submittedAt} />
                </td>
                <td className={labelled} data-label={t('col.changed')}>
                  <When iso={row.lastChangedAt} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// A phone card line: the column name before the value, as in the Team table.
const LABELLED =
  'max-lg:grid max-lg:grid-cols-[7rem_minmax(0,1fr)] max-lg:gap-x-2 max-lg:before:text-fg-muted max-lg:before:content-[attr(data-label)]';

/** A date over its time, so a narrow column never breaks inside either. */
function When({ iso }: { readonly iso: string | null }) {
  const text = formatInstant(iso);
  const split = text.lastIndexOf(', ');
  if (split < 0) return <span className="whitespace-nowrap">{text}</span>;
  return (
    <span className="block">
      <span className="block whitespace-nowrap">{text.slice(0, split)}</span>
      <span className="block whitespace-nowrap text-xs text-fg-muted">{text.slice(split + 2)}</span>
    </span>
  );
}

/** An email address that wraps before the @ rather than inside a word. */
function Email({ address }: { readonly address: string }) {
  const at = address.lastIndexOf('@');
  if (at <= 0) return <>{address}</>;
  return (
    <>
      {address.slice(0, at)}
      <wbr />
      {address.slice(at)}
    </>
  );
}
