import { Badge, CARD_TABLE, EmptyState, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { formatInstant, known, OFFER_STATUSES } from './format.ts';
import type { OfferView } from './types.ts';

export const OFFER_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  'pending-first-publish': 'attention',
  'changes-needed': 'critical',
  published: 'success',
  unknown: 'neutral',
};

/**
 * The seller's offers: product, SKU, state and whether the offer is on sale. From 1024 px a
 * table; below it each offer is a card with the state beside the name.
 */
export async function OffersTable({ items }: { readonly items: readonly OfferView[] }) {
  const t = await getTranslations();
  const cols = ['product', 'sku', 'status', 'listed', 'submitted'] as const;
  const head = (col: (typeof cols)[number]) =>
    t(col === 'status' ? 'catalog.col.status' : `catalog.offers.col.${col}`);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-160`}>
        <caption className="sr-only">{t('catalog.offers.title')}</caption>
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
                  icon="tag"
                  title={t('catalog.offers.empty.title')}
                  body={t('catalog.offers.empty.body')}
                />
              </td>
            </tr>
          ) : null}
          {items.map((offer) => {
            const status = known(offer.status, OFFER_STATUSES);
            return (
              <tr key={offer.offerId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} break-words font-medium`}>
                  <a className="text-link underline" href={`/offers/${offer.offerId}`}>
                    {offer.product.name ??
                      offer.product.productCode ??
                      t('catalog.products.unnamed')}
                  </a>
                </td>
                <td className={`${CARD_TABLE.labelled} break-words`} data-label={head('sku')}>
                  {offer.sellerSku}
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={OFFER_TONE[status] ?? 'neutral'}>
                    {t(`catalog.offers.status.${status}`)}
                  </Badge>
                </td>
                <td className={CARD_TABLE.labelled} data-label={head('listed')}>
                  {offer.listed ? t('catalog.offers.listed.yes') : t('catalog.offers.listed.no')}
                </td>
                <td className={CARD_TABLE.labelled} data-label={head('submitted')}>
                  {offer.submittedAt === null ? (
                    <span className="text-fg-muted">{t('catalog.not-given')}</span>
                  ) : (
                    formatInstant(offer.submittedAt)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
