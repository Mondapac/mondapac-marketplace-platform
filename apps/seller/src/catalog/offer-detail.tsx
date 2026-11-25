import { Banner, Card } from '@mondapac/ui';
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ShelfPicker, type ShelfChoice } from '../categories/shelf-picker.tsx';
import { FieldList } from './field-list.tsx';
import { formatInstant, known, OFFER_STATUSES, readable } from './format.ts';
import { OfferActions } from './offer-actions.tsx';
import { OfferHeader } from './offer-header.tsx';
import type { OfferView } from './types.ts';

const HANDLINGS = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'];
const CAUSES = [
  'type-not-allowed',
  'product-retired',
  'product-not-listed',
  'tag-suspended',
  'description-claim-text',
];

/**
 * The one page of an offer (Offer page PR 3): its state and what it needs next, "Your offer"
 * (condition, handling and description), then "Sizes, prices and stock" with its own explicit
 * Save, then the shelf. Why the offer is off sale comes before the sizes.
 */
export async function OfferDetail({
  offer,
  canEdit = false,
  csrfToken = '',
  shelves = [],
  sizes = null,
}: {
  readonly offer: OfferView;
  readonly canEdit?: boolean;
  readonly csrfToken?: string;
  /** The seller's active shelves (categories C9b); the picker shows only when there are some. */
  readonly shelves?: readonly ShelfChoice[];
  /** The sizes table (prices and stock); null when the seller may see neither. */
  readonly sizes?: ReactNode;
}) {
  const t = await getTranslations();
  const marketLocale = await getLocale();
  const zone = await getTimeZone();
  const status = known(offer.status, OFFER_STATUSES);
  const descriptions = Object.entries(offer.description);
  const offSale =
    offer.offSaleCauses.length > 0 ? (
      <Card title={t('catalog.offer.off-sale')}>
        <ul className="list-disc ps-5">
          {offer.offSaleCauses.map((cause) => (
            <li key={cause}>{t(`catalog.offer.cause.${known(cause, CAUSES)}`)}</li>
          ))}
        </ul>
      </Card>
    ) : null;
  return (
    <div className="flex flex-col gap-6">
      <OfferHeader offer={offer} canEdit={canEdit} t={t} />
      {status === 'changes-needed' ? (
        <Banner tone="attention">{t('catalog.offer-actions.changes-needed')}</Banner>
      ) : null}
      {status === 'pending-first-publish' ? (
        <Banner tone="info">{t('catalog.offer-actions.waiting')}</Banner>
      ) : null}
      {canEdit ? (
        <OfferActions offerId={offer.offerId} status={status} csrfToken={csrfToken} />
      ) : null}
      <Card title={t('catalog.offer.your-offer')}>
        <FieldList
          rows={[
            { label: t('catalog.offers.col.sku'), value: offer.sellerSku },
            { label: t('catalog.offer.condition'), value: readable(offer.conditionCode) },
            {
              label: t('catalog.offers.col.listed'),
              value: offer.listed ? t('catalog.offers.listed.yes') : t('catalog.offers.listed.no'),
            },
            {
              label: t('catalog.offer.attestation'),
              value: offer.attestationRecorded
                ? t('catalog.offer.attested')
                : t('catalog.offer.not-attested'),
            },
            {
              label: t('catalog.offer.handling'),
              value:
                offer.handling === null
                  ? null
                  : t(`catalog.offer.handling-value.${known(offer.handling, HANDLINGS)}`),
            },
            {
              label: t('catalog.offers.col.submitted'),
              value:
                offer.submittedAt === null
                  ? null
                  : formatInstant(offer.submittedAt, marketLocale, zone),
            },
            {
              label: t('catalog.offer.first-published'),
              value:
                offer.firstPublishedAt === null
                  ? null
                  : formatInstant(offer.firstPublishedAt, marketLocale, zone),
            },
            {
              label: t('catalog.product.created'),
              value: formatInstant(offer.createdAt, marketLocale, zone),
            },
          ]}
        />
        {descriptions.length > 0 ? (
          <div className="mt-4 flex flex-col gap-1 border-t border-line pt-4">
            <h3 className="text-sm font-medium">{t('catalog.offer.description')}</h3>
            {descriptions.map(([locale, text]) => (
              <p key={locale} className="whitespace-pre-line break-words">
                <span className="me-2 text-sm text-fg-muted">{locale}</span>
                {text}
              </p>
            ))}
          </div>
        ) : null}
      </Card>
      {offSale}
      {sizes}
      {canEdit && shelves.length > 0 ? (
        <ShelfPicker
          offerId={offer.offerId}
          version={offer.version}
          shelves={shelves}
          csrfToken={csrfToken}
        />
      ) : null}
    </div>
  );
}
