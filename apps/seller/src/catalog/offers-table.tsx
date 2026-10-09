import { Badge, type BadgeTone } from '@mondapac/ui';
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

/** The seller's offers: product, SKU, state and whether the offer is on sale. */
export async function OffersTable({ items }: { readonly items: readonly OfferView[] }) {
  const t = await getTranslations();
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-line p-6">
        <p className="font-medium">{t('catalog.offers.empty.title')}</p>
        <p className="mt-1 text-fg-muted">{t('catalog.offers.empty.body')}</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-start text-sm">
        <caption className="sr-only">{t('catalog.offers.title')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.offers.col.product')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.offers.col.sku')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.col.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.offers.col.listed')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('catalog.offers.col.submitted')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {items.map((offer) => {
            const status = known(offer.status, OFFER_STATUSES);
            return (
              <tr key={offer.offerId}>
                <td className="break-words px-4 py-3 font-medium">
                  <a className="text-link underline" href={`/offers/${offer.offerId}`}>
                    {offer.product.name ??
                      offer.product.productCode ??
                      t('catalog.products.unnamed')}
                  </a>
                </td>
                <td className="break-words px-4 py-3">{offer.sellerSku}</td>
                <td className="px-4 py-3">
                  <Badge tone={OFFER_TONE[status] ?? 'neutral'}>
                    {t(`catalog.offers.status.${status}`)}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {offer.listed ? t('catalog.offers.listed.yes') : t('catalog.offers.listed.no')}
                </td>
                <td className="px-4 py-3">{formatInstant(offer.submittedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
