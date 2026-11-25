import { BackLink, Badge, LinkButton, PageHeader } from '@mondapac/ui';
import { known, OFFER_STATUSES } from './format.ts';
import { OFFER_TONE } from './offer-tone.ts';
import type { OfferView } from './types.ts';

/**
 * The top of every offer page: the way back, the product name with the offer's state and, on the
 * offer page itself, "Edit offer" in the same row. The offer is one page (Offer page PR 3): the
 * Prices and Stock pages that remain open from it and lead back to it.
 */
export function OfferHeader({
  offer,
  back = 'offers',
  canEdit = false,
  title,
  t,
}: {
  readonly offer: OfferView;
  /** `offers` on the offer page (back to the list); `offer` on a page opened from it. */
  readonly back?: 'offers' | 'offer';
  /** Shows "Edit offer" on the offer page while the offer is not published. */
  readonly canEdit?: boolean;
  /** A page opened from the offer names itself ("Prices"); the offer page names the product. */
  readonly title?: string;
  readonly t: (key: string) => string;
}) {
  const status = known(offer.status, OFFER_STATUSES);
  const base = `/offers/${offer.offerId}`;
  return (
    <div className="flex flex-col items-start gap-2">
      {back === 'offers' ? (
        <BackLink href="/offers" label={t('catalog.offers.back')} />
      ) : (
        <BackLink href={base} label={t('catalog.offer.back')} />
      )}
      <div className="flex w-full flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={title ?? offer.product.name ?? offer.product.productCode ?? offer.sellerSku}
          badges={
            <Badge tone={OFFER_TONE[status] ?? 'neutral'}>
              {t(`catalog.offers.status.${status}`)}
            </Badge>
          }
          className="min-w-0"
        />
        {canEdit && back === 'offers' && status !== 'published' ? (
          <LinkButton variant="secondary" href={`${base}/edit`} className="max-sm:w-full">
            {t('catalog.offer-edit.title')}
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}
