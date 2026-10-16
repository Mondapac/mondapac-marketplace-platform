import { Banner, Card } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
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

/** One offer of the seller, read only: its state, why it is off sale and what it needs next. */
export async function OfferDetail({
  offer,
  canEdit = false,
  canViewStock = false,
  canViewPrices = false,
  csrfToken = '',
}: {
  readonly offer: OfferView;
  readonly canEdit?: boolean;
  readonly canViewStock?: boolean;
  readonly canViewPrices?: boolean;
  readonly csrfToken?: string;
}) {
  const t = await getTranslations();
  const status = known(offer.status, OFFER_STATUSES);
  const descriptions = Object.entries(offer.description);
  return (
    <div className="flex flex-col gap-6">
      <OfferHeader
        offer={offer}
        active="details"
        canViewPrices={canViewPrices}
        canViewStock={canViewStock}
        canEdit={canEdit}
        t={t}
      />
      {status === 'changes-needed' ? (
        <Banner tone="attention">{t('catalog.offer-actions.changes-needed')}</Banner>
      ) : null}
      {status === 'pending-first-publish' ? (
        <Banner tone="info">{t('catalog.offer-actions.waiting')}</Banner>
      ) : null}
      {canEdit ? (
        <OfferActions offerId={offer.offerId} status={status} csrfToken={csrfToken} />
      ) : null}
      <Card>
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
              value: offer.submittedAt === null ? null : formatInstant(offer.submittedAt),
            },
            {
              label: t('catalog.offer.first-published'),
              value: offer.firstPublishedAt === null ? null : formatInstant(offer.firstPublishedAt),
            },
            { label: t('catalog.product.created'), value: formatInstant(offer.createdAt) },
          ]}
        />
      </Card>
      {offer.offSaleCauses.length > 0 ? (
        <Card title={t('catalog.offer.off-sale')}>
          <ul className="list-disc ps-5">
            {offer.offSaleCauses.map((cause) => (
              <li key={cause}>{t(`catalog.offer.cause.${known(cause, CAUSES)}`)}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {descriptions.length > 0 ? (
        <Card title={t('catalog.offer.description')}>
          {descriptions.map(([locale, text]) => (
            <p key={locale} className="whitespace-pre-line break-words">
              <span className="me-2 text-sm text-fg-muted">{locale}</span>
              {text}
            </p>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
