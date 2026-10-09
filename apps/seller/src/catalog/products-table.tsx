import { Badge, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
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

/** The seller's products with their state and whether a change waits for review. */
export async function ProductsTable({ items }: { readonly items: readonly ProductListItem[] }) {
  const t = await getTranslations();
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-line p-6">
        <p className="font-medium">{t('catalog.products.empty.title')}</p>
        <p className="mt-1 text-fg-muted">{t('catalog.products.empty.body')}</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-start text-sm">
        <caption className="sr-only">{t('catalog.products.title')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.products.col.product')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.products.col.code')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.col.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.col.changed')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {items.map((item) => {
            const status = known(item.status, PRODUCT_STATUSES);
            return (
              <tr key={item.productId}>
                <td className="break-words px-4 py-3 font-medium">
                  <a className="text-link underline" href={`/products/${item.productId}`}>
                    {item.draftName ?? t('catalog.products.unnamed')}
                  </a>
                </td>
                <td className="px-4 py-3">{item.productCode}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={TONE[status] ?? 'neutral'}>
                      {t(`catalog.products.status.${status}`)}
                    </Badge>
                    {item.hasPendingRevision ? (
                      <Badge tone="attention">{t('catalog.products.pending')}</Badge>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3">{formatInstant(item.lastChangedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
