'use client';

import { Banner, Card, TextField, type SectionResult } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PriceBarForm, usePricePart } from './price-bar.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { priceProblemOf } from './errors.ts';
import { formatMinor, inputOf, minorOf } from './money.ts';
import { FALLBACK_ZONE, formatInZone } from './zone-time.ts';
import { SpecialPrice } from './special-price.tsx';
import type { OfferPricesView, PriceWritten, VariantPrice } from './types.ts';

const KIND = {
  accepted: 'success',
  'pending-review': 'review',
  unchanged: 'unchanged',
} as const;

/** The same price: equal amounts when both read, else the same text ("10" is "10.00"). */
function samePrice(a: string, b: string, currency: string): boolean {
  const x = minorOf(a, currency);
  const y = minorOf(b, currency);
  return x !== null && y !== null ? x === y : a.trim() === b.trim();
}

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
  const [version, setVersionState] = useState(variant.seriesVersion);
  // The version a save in a run reads: a regular price saved first moves it for the special.
  const versionRef = useRef(variant.seriesVersion);
  const setVersion = (next: number | null) => {
    versionRef.current = next;
    setVersionState(next);
  };
  const initialText = variant.inForce === null ? '' : inputOf(variant.inForce.amount, currency);
  const [text, setText] = useState(initialText);
  // The text last sent and taken: a price waiting for review stays typed, but is not a new change.
  const [savedText, setSavedText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  // A page refresh brings the version the server holds now; the typed text and message stay.
  useEffect(() => setVersion(variant.seriesVersion), [variant.seriesVersion]);
  const readOnly = !canEdit || variant.retired;

  function check(): boolean {
    const ok = minorOf(text, currency) !== null;
    setError(ok ? null : t('price.error.invalid'));
    return ok;
  }

  async function save(): Promise<SectionResult> {
    const amount = minorOf(text, currency);
    if (amount === null) return 'failed';
    setError(null);
    const sent = text;
    const result = await callGuarded<PriceWritten>(
      'PUT',
      `pricing/seller/offers/${offerId}/variants/${variant.variantId}/regular-price`,
      { amount, currency, expectedVersion: versionRef.current },
      csrfToken,
    );
    if (isStepUpCancelled(result)) return 'stopped';
    if (!result.ok) {
      if (result.failure.status === 401) return part.signedOut();
      const problem = priceProblemOf(result.failure);
      setError(t(`price.error.${problem}`));
      // The price changed elsewhere: read it again; the page shows the new version.
      if (problem === 'stale') router.refresh();
      return 'failed';
    }
    setVersion(result.body.seriesVersion);
    setSavedText(sent);
    // A price that waits for review, or did not change, is news rather than a done deal.
    part.note({
      message: t(`price.saved.${result.body.status}`),
      kind: KIND[result.body.status],
    });
    router.refresh();
    return 'saved';
  }

  const part = usePricePart(`${variant.variantId}:regular`, {
    dirty: !readOnly && !samePrice(text, savedText, currency),
    check,
    save,
    discard: () => {
      setText(savedText);
      setError(null);
    },
  });

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
          <TextField
            name={`price-${variant.variantId}`}
            label={t('price.field', { currency })}
            // Every variant has the same field: the name read out carries the variant.
            aria-label={`${t('price.field', { currency })}, ${t('price.variant', { number })}`}
            inputMode="decimal"
            value={text}
            error={error ?? undefined}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
        )}
        {variant.seriesVersion === null && variant.special === null ? null : (
          <SpecialPrice
            offerId={offerId}
            variant={variant}
            currency={currency}
            canEdit={!readOnly}
            csrfToken={csrfToken}
            zone={zone}
            number={number}
            version={version}
            versionRef={versionRef}
            onVersion={setVersion}
          />
        )}
      </div>
    </Card>
  );
}

/**
 * Prices of one offer: a section per variant with the price in force, a held one, the regular
 * price field and the special price. Every changed price is saved by the page's one save bar.
 */
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
  // Per variant, the regular price first: the special must stay below the price it saves.
  const order = view.variants.flatMap((variant) => [
    `${variant.variantId}:regular`,
    `${variant.variantId}:special`,
  ]);
  return (
    <PriceBarForm order={order} page={t('price.title')} enabled={canEdit}>
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
    </PriceBarForm>
  );
}
