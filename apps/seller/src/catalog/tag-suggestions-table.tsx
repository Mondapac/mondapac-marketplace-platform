import { Badge, CARD_TABLE, EmptyState, type BadgeTone } from '@mondapac/ui';
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { pickLabel } from './draft-content.ts';
import { formatInstant, known } from './format.ts';
import { SUGGESTION_STATUSES, type OwnTopicSuggestion } from './types.ts';

const TONE: Record<string, BadgeTone> = {
  open: 'attention',
  approved: 'success',
  mapped: 'info',
  rejected: 'neutral',
  unknown: 'neutral',
};

/**
 * The seller's tag suggestions with their outcome (the seller panel's "Tag suggestions" page).
 * Everything a seller or reviewer typed is shown as text, never as markup. From 1024 px a table;
 * below it each suggestion is a card with its status beside the tag. An approved or mapped tag is
 * never added to the product for the seller, and every such row says so.
 */
export async function TagSuggestionsTable({
  items,
  defaultLocale,
  filtered = false,
  emptyAction,
}: {
  readonly items: readonly OwnTopicSuggestion[];
  readonly defaultLocale: string;
  /** A status tab is chosen: an empty list means none in that status, not none at all. */
  readonly filtered?: boolean;
  /** The next step on an empty list ("Suggest a tag"), for a seller who may make one. */
  readonly emptyAction?: ReactNode;
}) {
  const t = await getTranslations('catalog.tagSuggestions');
  const locale = await getLocale();
  const zone = await getTimeZone();
  const cols = ['tag', 'product', 'status', 'outcome', 'sent'] as const;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-200`}>
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
          {items.length === 0 ? (
            <tr className="max-lg:block">
              <td colSpan={cols.length} className="max-lg:block">
                <EmptyState
                  size="compact"
                  icon="inbox"
                  title={t(filtered ? 'empty-filtered.title' : 'empty.title')}
                  body={t(filtered ? 'empty-filtered.body' : 'empty.body')}
                  action={emptyAction}
                />
              </td>
            </tr>
          ) : null}
          {items.map((item) => {
            const status = known(item.status, SUGGESTION_STATUSES);
            const name =
              item.topic === null
                ? null
                : pickLabel(item.topic.names, defaultLocale, item.topic.slug);
            const decidedWithTag = (status === 'approved' || status === 'mapped') && name !== null;
            const outcome = decidedWithTag
              ? t(status === 'approved' ? 'outcome.approved' : 'outcome.mapped', { name })
              : status === 'rejected'
                ? item.rejectReason === null || item.rejectReason === ''
                  ? t('outcome.rejected')
                  : t('outcome.rejected-reason', { reason: item.rejectReason })
                : status === 'open'
                  ? t('outcome.open')
                  : '';
            return (
              <tr key={item.id} className={CARD_TABLE.row} data-testid={`suggestion-${item.id}`}>
                <td className={`${CARD_TABLE.cell} break-words font-medium`}>{item.label}</td>
                <td className={`${CARD_TABLE.labelled} break-words`} data-label={t('col.product')}>
                  {item.product.productCode === null ? (
                    t('product-gone')
                  ) : (
                    <a className="text-link underline" href={`/products/${item.product.id}`}>
                      {item.product.name ?? item.product.productCode}
                    </a>
                  )}
                </td>
                <td className={CARD_TABLE.corner}>
                  <div className="flex flex-wrap gap-1 max-lg:justify-end">
                    <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
                  </div>
                </td>
                <td className={`${CARD_TABLE.labelled} break-words`} data-label={t('col.outcome')}>
                  <p>{outcome}</p>
                  {decidedWithTag ? (
                    <p className="mt-1 text-sm text-fg-muted">
                      {item.topic?.status === 'archived'
                        ? t('outcome.retired')
                        : t('outcome.add-it')}
                      {item.topic?.status !== 'archived' && item.product.productCode !== null ? (
                        <>
                          {' '}
                          <a className="text-link underline" href={`/products/${item.product.id}`}>
                            {t('outcome.open-product')}
                          </a>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.sent')}>
                  {formatInstant(item.createdAt, locale, zone)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
