import { Badge, CARD_TABLE, EmptyState, type BadgeTone } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { formatInstant, known, PRODUCT_STATUSES } from './format.ts';
import type { ProductListItem } from './types.ts';

const TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  unpublished: 'attention',
  published: 'success',
  matched: 'info',
  retired: 'neutral',
  unknown: 'neutral',
};

/**
 * The seller's products with their state and whether a change waits for review. From 1024 px a
 * table; below it each product is a card with the state beside the name.
 */
export async function ProductsTable({
  items,
  emptyAction,
}: {
  readonly items: readonly ProductListItem[];
  /** The next step on an empty list ("New product"), for a seller who may add one. */
  readonly emptyAction?: ReactNode;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  const cols = ['product', 'code', 'status', 'changed'] as const;
  const head = (col: (typeof cols)[number]) =>
    t(col === 'status' || col === 'changed' ? `catalog.col.${col}` : `catalog.products.col.${col}`);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-160`}>
        <caption className="sr-only">{t('catalog.products.title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {cols.map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {head(col)}
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
                  icon="package"
                  title={t('catalog.products.empty.title')}
                  body={t('catalog.products.empty.body')}
                  action={emptyAction}
                />
              </td>
            </tr>
          ) : null}
          {items.map((item) => {
            const status = known(item.status, PRODUCT_STATUSES);
            return (
              <tr key={item.productId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} break-words font-medium`}>
                  <a className="text-link underline" href={`/products/${item.productId}`}>
                    {item.draftName ?? t('catalog.products.unnamed')}
                  </a>
                </td>
                <td className={`${CARD_TABLE.labelled} break-all`} data-label={head('code')}>
                  {item.productCode}
                </td>
                <td className={CARD_TABLE.corner}>
                  <div className="flex flex-wrap gap-1 max-lg:justify-end">
                    <Badge tone={TONE[status] ?? 'neutral'}>
                      {t(`catalog.products.status.${status}`)}
                    </Badge>
                    {item.hasPendingRevision ? (
                      <Badge tone="attention">{t('catalog.products.pending')}</Badge>
                    ) : null}
                  </div>
                </td>
                <td className={CARD_TABLE.labelled} data-label={head('changed')}>
                  {formatInstant(item.lastChangedAt, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
