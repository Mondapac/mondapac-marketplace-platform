import { Badge, CARD_TABLE, EmptyState } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { STATUS_TONE, type TypeRow } from './types.ts';

/** The certificate types of the Market, one card each below 1024 px. */
export function TypesTable({ rows }: { readonly rows: readonly TypeRow[] }) {
  const t = useTranslations('certificates.types');
  const locale = useLocale();
  const language = locale.split('-')[0] ?? locale;
  if (rows.length === 0) return <EmptyState icon="shield-check" title={t('empty')} />;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {['name', 'status', 'code', 'mode', 'revision'].map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => {
            const name = row.names[locale] ?? row.names[language] ?? Object.values(row.names)[0];
            return (
              <tr key={row.typeId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} min-w-0`}>
                  <a
                    className="font-medium wrap-anywhere text-link underline"
                    href={`/certificates/types/${row.typeId}`}
                  >
                    {name !== undefined && name !== '' ? name : row.code}
                  </a>
                  {row.pending.length === 0 ? null : (
                    <span className="ms-2">
                      <Badge tone="attention">{t('pending')}</Badge>
                    </span>
                  )}
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.code')}>
                  {row.code}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.mode')}>
                  {t.has(`mode.${row.verificationMode}` as never)
                    ? t(`mode.${row.verificationMode}` as never)
                    : row.verificationMode}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.revision')}>
                  {row.publishedRevisionNo}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
