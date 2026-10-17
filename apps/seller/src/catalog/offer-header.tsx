import { BackLink, Badge, LinkButton, Tabs } from '@mondapac/ui';
import { known, OFFER_STATUSES } from './format.ts';
import { OFFER_TONE } from './offers-table.tsx';
import type { OfferView } from './types.ts';

export type OfferTab = 'details' | 'prices' | 'stock';

/**
 * The top of every offer page: the way back to Offers, the product name with the offer's state,
 * and one tab per page of the offer (details, prices, stock levels) the seller may open.
 */
export function OfferHeader({
  offer,
  active,
  canViewPrices,
  canViewStock,
  canEdit = false,
  t,
}: {
  readonly offer: OfferView;
  readonly active: OfferTab;
  readonly canViewPrices: boolean;
  readonly canViewStock: boolean;
  /** Shows "Edit offer" on the details tab while the offer is not published. */
  readonly canEdit?: boolean;
  readonly t: (key: string) => string;
}) {
  const status = known(offer.status, OFFER_STATUSES);
  const base = `/offers/${offer.offerId}`;
  const tabs = [
    { id: 'details', href: base, label: t('catalog.offer.tab.details') },
    ...(canViewPrices || active === 'prices'
      ? [{ id: 'prices', href: `${base}/prices`, label: t('price.title') }]
      : []),
    ...(canViewStock || active === 'stock'
      ? [{ id: 'stock', href: `${base}/stock`, label: t('stock.levels.title') }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-2">
        <BackLink href="/offers" label={t('catalog.offers.back')} />
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words text-2xl font-semibold">
              {offer.product.name ?? offer.product.productCode ?? offer.sellerSku}
            </h1>
            <Badge tone={OFFER_TONE[status] ?? 'neutral'}>
              {t(`catalog.offers.status.${status}`)}
            </Badge>
          </div>
          {canEdit && active === 'details' && status !== 'published' ? (
            <LinkButton variant="secondary" href={`${base}/edit`} className="max-sm:w-full">
              {t('catalog.offer-edit.title')}
            </LinkButton>
          ) : null}
        </div>
      </div>
      {tabs.length > 1 ? (
        <Tabs label={t('catalog.offer.tabs')} items={tabs} activeId={active} />
      ) : null}
    </div>
  );
}
