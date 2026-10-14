'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../catalog/format.ts';
import { priceProblemOf } from './errors.ts';
import { formatMinor, inputOf, minorOf } from './money.ts';
import type { OfferPricesView, PriceWritten, VariantPrice } from './types.ts';

function VariantRow({
  offerId,
  number,
  variant,
  currency,
  canEdit,
  csrfToken,
}: {
  readonly offerId: string;
  readonly number: number;
  readonly variant: VariantPrice;
  readonly currency: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [version, setVersion] = useState(variant.seriesVersion);
  const [text, setText] = useState(
    variant.inForce === null ? '' : inputOf(variant.inForce.amount, currency),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PriceWritten['status'] | null>(null);
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
    setDone(null);
    const result = await callApi<PriceWritten>(
      'PUT',
      `pricing/seller/offers/${offerId}/variants/${variant.variantId}/regular-price`,
      { amount, currency, expectedVersion: version },
      csrfToken,
    );
    setPending(false);
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
    setDone(result.body.status);
    router.refresh();
  }

  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="mb-3 text-lg font-semibold">{t('price.variant', { number })}</h2>
      <p className="mb-2 text-fg-muted">
        {variant.inForce === null
          ? t('price.none')
          : t('price.in-force', {
              amount: formatMinor(variant.inForce.amount, currency),
              since: formatInstant(variant.inForce.effectiveFrom),
            })}
      </p>
      {variant.held !== null ? (
        <div className="mb-3">
          <Banner tone="attention">
            <p>
              {t(`price.held.${variant.held.direction}`, {
                amount: formatMinor(variant.held.amount, currency),
                since: formatInstant(variant.held.submittedAt),
              })}
            </p>
          </Banner>
        </div>
      ) : null}
      {variant.retired ? <p className="text-fg-muted">{t('price.retired')}</p> : null}
      {readOnly ? null : (
        <form className="flex flex-col gap-1" onSubmit={(event) => void submit(event)} noValidate>
          <div className="flex items-end gap-2">
            <TextField
              name={`price-${variant.variantId}`}
              label={t('price.field', { currency })}
              inputMode="decimal"
              value={text}
              error={error ?? undefined}
              onChange={(event) => {
                setText(event.target.value);
                setDone(null);
              }}
            />
            <Button
              type="submit"
              variant="secondary"
              loading={pending}
              disabled={pending || text.trim() === ''}
            >
              {t('price.save')}
            </Button>
          </div>
          {done === null ? null : (
            <span className="text-sm text-fg-muted">{t(`price.saved.${done}`)}</span>
          )}
        </form>
      )}
    </section>
  );
}

/** Regular prices of one offer: a section per variant with the price in force, a held one and a form. */
export function OfferPrices({
  offerId,
  view,
  canEdit,
  csrfToken,
}: {
  readonly offerId: string;
  readonly view: OfferPricesView;
  readonly canEdit: boolean;
  readonly csrfToken: string;
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
        />
      ))}
    </div>
  );
}
