import { CARD_TABLE, EmptyState } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { shortId } from '../../shared/short-id.ts';
import { When } from '../../shared/when.tsx';
import type { RequestRow } from './types.ts';

/**
 * Open issuer requests, oldest first (the API order). One link per row, on the store name; a seller
 * that is not approved yet shows the fallback word and its short id.
 */
export function RequestsTable({
  rows,
  typeNames,
  morePages,
}: {
  readonly rows: readonly RequestRow[];
  readonly typeNames: ReadonlyMap<string, string>;
  readonly morePages: boolean;
}) {
  const t = useTranslations('certificates.requests');
  if (rows.length === 0) {
    return <EmptyState icon="shield-check" title={t(morePages ? 'empty-page' : 'empty')} />;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {['seller', 'type', 'files', 'waiting'].map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => (
            <tr key={row.issuerRequestId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} min-w-0`}>
                {row.storeName === null ? (
                  <>
                    <span className="block text-fg-muted">{t('seller-fallback')}</span>
                    <a
                      className="font-medium text-link underline"
                      href={`/certificates/issuer-requests/${row.issuerRequestId}`}
                      aria-label={t('open-request-from', {
                        store: t('seller-fallback'),
                        id: shortId(row.sellerId),
                      })}
                    >
                      {t('open-request')}
                    </a>
                  </>
                ) : (
                  <a
                    className="font-medium wrap-anywhere text-link underline"
                    href={`/certificates/issuer-requests/${row.issuerRequestId}`}
                  >
                    {row.storeName}
                  </a>
                )}
                <span className="block text-xs text-fg-muted">
                  {t('seller-id', { id: shortId(row.sellerId) })}
                </span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.type')}>
                {typeNames.get(row.typeCode) ?? row.typeCode}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.files')}>
                {row.documentCount}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.waiting')}>
                <When iso={row.createdAt} missing="-" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
