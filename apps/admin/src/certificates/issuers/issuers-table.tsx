import { CARD_TABLE, EmptyState } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { When } from '../../shared/when.tsx';
import { IssuerStateBadge } from './state-badge.tsx';
import type { IssuerRow } from './types.ts';

/** The issuers of the Market, newest first as the API orders them; one card each below 1024 px. */
export function IssuersTable({
  rows,
  typeNames,
  morePages,
}: {
  readonly rows: readonly IssuerRow[];
  readonly typeNames: ReadonlyMap<string, string>;
  /** A next page exists, so an empty list here does not mean an empty registry. */
  readonly morePages: boolean;
}) {
  const t = useTranslations('certificates.issuers');
  if (rows.length === 0) {
    return <EmptyState icon="shield-check" title={t(morePages ? 'empty-page' : 'empty')} />;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {['name', 'type', 'state', 'accreditation', 'changed'].map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => (
            <tr key={row.issuerId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} min-w-0`}>
                <a
                  className="font-medium wrap-anywhere text-link underline"
                  href={`/certificates/issuers/${row.issuerId}`}
                >
                  {row.displayName}
                </a>
              </td>
              <td className={CARD_TABLE.corner}>
                <IssuerStateBadge state={row.state} />
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.type')}>
                {typeNames.get(row.typeCode) ?? row.typeCode}
              </td>
              <td
                className={`${CARD_TABLE.labelled} wrap-anywhere`}
                data-label={t('col.accreditation')}
              >
                {row.accreditationNumber ?? <span className="text-fg-muted">-</span>}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.changed')}>
                <When iso={row.stateChangedAt} missing="-" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
