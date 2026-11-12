import { Badge, CARD_TABLE, EmptyState } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import type { QueueRow, SubmissionKind } from './types.ts';

const KIND_TONE = { initial: 'neutral', resubmission: 'attention', renewal: 'info' } as const;
const kindTone = (kind: SubmissionKind) => KIND_TONE[kind];

/**
 * The seller certificates waiting for a decision, oldest first (the API order). Read-only here:
 * the review page and its decisions are a separate screen. The type shows its name when the
 * reader may view types, otherwise its code.
 */
export function CertificateQueue({
  rows,
  typeNames,
  morePages,
}: {
  readonly rows: readonly QueueRow[];
  readonly typeNames: ReadonlyMap<string, string>;
  /** A next page exists, so an empty list here does not mean an empty queue. */
  readonly morePages: boolean;
}) {
  const t = useTranslations('certificates.queue');
  if (rows.length === 0) {
    return <EmptyState icon="shield-check" title={t(morePages ? 'empty-page' : 'empty')} />;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {['seller', 'type', 'kind', 'issuer', 'waiting'].map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => (
            <tr key={row.submissionId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} min-w-0`}>
                <a
                  className="font-medium wrap-anywhere text-link underline"
                  href={`/sellers/${row.sellerId}`}
                  title={row.sellerId}
                >
                  {row.storeName ?? t('seller-fallback')}
                  <span className="sr-only">
                    {t('seller-id-sr', { id: shortId(row.sellerId) })}
                  </span>
                </a>
                <span className="block text-xs text-fg-muted">{shortId(row.sellerId)}</span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.type')}>
                {typeNames.get(row.typeCode) ?? row.typeCode}
              </td>
              <td className={CARD_TABLE.corner} data-label={t('col.kind')}>
                <Badge tone={kindTone(row.kind)}>{t(`kind.${row.kind}`)}</Badge>
                <span className="block text-xs text-fg-muted">
                  {t('submission-no', { n: row.submissionNo })}
                </span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.issuer')}>
                {row.issuerName ?? <span className="text-fg-muted">{t('no-issuer')}</span>}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('col.waiting')}>
                <When iso={row.submittedAt} missing="-" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
