'use client';

import { Banner, Button, Card, FieldAction, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { priceProblemOf } from './errors.ts';
import { formatMinor, inputOf, minorOf } from './money.ts';
import { FALLBACK_ZONE, formatInZone } from './zone-time.ts';
import { SpecialPrice } from './special-price.tsx';
import type { OfferPricesView, PriceWritten, VariantPrice } from './types.ts';

function VariantRow({
  offerId,
  number,
  variant,
  currency,
  canEdit,
  csrfToken,
  zone,
}: {
  readonly offerId: string;
  readonly number: number;
  readonly variant: VariantPrice;
  readonly currency: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const callGuarded = useGuardedCall();
  const [version, setVersion] = useState(variant.seriesVersion);
  const [text, setText] = useState(
    variant.inForce === null ? '' : inputOf(variant.inForce.amount, currency),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A page refresh brings the version the server holds now; the typed text and message stay.
  useEffect(() => setVersion(variant.seriesVersion), [variant.seriesVersion]);
  const readOnly = !canEdit || variant.retired;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const amount = minorOf(text, currency);
    if (amount === null) {
      setError(t('price.error.invalid'));
      return;
    }
    setPending(true);
    setError(null);
    const result = await callGuarded<PriceWritten>(
      'PUT',
      `pricing/seller/offers/${offerId}/variants/${variant.variantId}/regular-price`,
      { amount, currency, expectedVersion: version },
      csrfToken,
    );
    setPending(false);
    if (isStepUpCancelled(result)) return;
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else {
        const problem = priceProblemOf(result.failure);
        setError(t(`price.error.${problem}`));
        // The price changed elsewhere: read it again; the page shows the new version.
        if (problem === 'stale') router.refresh();
      }
      return;
    }
    setVersion(result.body.seriesVersion);
    const message = t(`price.saved.${result.body.status}`);
    // A price that waits for review, or did not change, is news rather than a done deal.
    if (result.body.status === 'accepted') toast.success(message);
    else toast.info(message);
    router.refresh();
  }

  return (
    <Card title={t('price.variant', { number })}>
      <div className="max-w-(--mp-size-form-max)">
        <p className="mb-2 text-fg-muted">
          {variant.inForce === null
            ? t('price.none')
            : t('price.in-force', {
                amount: formatMinor(variant.inForce.amount, currency, locale),
                since: formatInZone(variant.inForce.effectiveFrom, zone, locale),
              })}
        </p>
        {variant.held !== null ? (
          <div className="mb-3">
            <Banner tone="attention">
              <p>
                {t(`price.held.${variant.held.direction}`, {
                  amount: formatMinor(variant.held.amount, currency, locale),
                  since: formatInZone(variant.held.submittedAt, zone, locale),
                })}
              </p>
            </Banner>
          </div>
        ) : null}
        {variant.retired ? <p className="text-fg-muted">{t('price.retired')}</p> : null}
        {readOnly ? null : (
          <form className="flex flex-col gap-1" onSubmit={(event) => void submit(event)} noValidate>
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                <TextField
                  name={`price-${variant.variantId}`}
                  label={t('price.field', { currency })}
                  inputMode="decimal"
                  value={text}
                  error={error ?? undefined}
                  onChange={(event) => {
                    setText(event.target.value);
                  }}
                />
              </div>
              <FieldAction>
                <Button
                  type="submit"
                  variant="secondary"
                  loading={pending}
                  disabled={pending || text.trim() === ''}
                >
                  {t('price.save')}
                </Button>
              </FieldAction>
            </div>
          </form>
        )}
        {variant.seriesVersion === null && variant.special === null ? null : (
          <SpecialPrice
            offerId={offerId}
            variant={variant}
            currency={currency}
            canEdit={!readOnly}
            csrfToken={csrfToken}
            zone={zone}
            version={version}
            onVersion={setVersion}
          />
        )}
      </div>
    </Card>
  );
}

/** Regular prices of one offer: a section per variant with the price in force, a held one and a form. */
export function OfferPrices({
  offerId,
  view,
  canEdit,
  csrfToken,
  zone = FALLBACK_ZONE,
}: {
  readonly offerId: string;
  readonly view: OfferPricesView;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** The seller's IANA zone; UTC when it could not be read. */
  readonly zone?: string;
}) {
  const t = useTranslations();
  if (view.variants.length === 0) {
    return <p className="text-fg-muted">{t('price.no-variants')}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {view.variants.map((variant, index) => (
        <VariantRow
          key={variant.variantId}
          offerId={offerId}
          number={index + 1}
          variant={variant}
          currency={view.currency}
          canEdit={canEdit}
          csrfToken={csrfToken}
          zone={zone}
        />
      ))}
    </div>
  );
}
