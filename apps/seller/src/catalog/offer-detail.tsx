import { Badge } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { FieldList } from './field-list.tsx';
import { formatInstant, known, OFFER_STATUSES } from './format.ts';
import { OFFER_TONE } from './offers-table.tsx';
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
export async function OfferDetail({ offer }: { readonly offer: OfferView }) {
  const t = await getTranslations();
  const status = known(offer.status, OFFER_STATUSES);
  const name = offer.product.name ?? offer.product.productCode ?? offer.sellerSku;
  const descriptions = Object.entries(offer.description);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-words text-2xl font-semibold">{name}</h1>
        <Badge tone={OFFER_TONE[status] ?? 'neutral'}>{t(`catalog.offers.status.${status}`)}</Badge>
      </div>
      <FieldList
        rows={[
          { label: t('catalog.offers.col.sku'), value: offer.sellerSku },
          { label: t('catalog.offer.condition'), value: offer.conditionCode },
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
      {offer.offSaleCauses.length > 0 ? (
        <section className="rounded-lg border border-line p-4">
          <h2 className="mb-2 text-lg font-semibold">{t('catalog.offer.off-sale')}</h2>
          <ul className="list-disc ps-5">
            {offer.offSaleCauses.map((cause) => (
              <li key={cause}>{t(`catalog.offer.cause.${known(cause, CAUSES)}`)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {descriptions.length > 0 ? (
        <section className="rounded-lg border border-line p-4">
          <h2 className="mb-2 text-lg font-semibold">{t('catalog.offer.description')}</h2>
          {descriptions.map(([locale, text]) => (
            <p key={locale} className="whitespace-pre-line break-words">
              <span className="me-2 text-fg-muted">{locale}</span>
              {text}
            </p>
          ))}
        </section>
      ) : null}
      <p>
        <a className="font-medium text-link underline" href="/offers">
          {t('catalog.offers.back')}
        </a>
      </p>
    </div>
  );
}
