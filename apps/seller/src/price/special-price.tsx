'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../catalog/format.ts';
import { priceProblemOf } from './errors.ts';
import { formatMinor, minorOf } from './money.ts';
import type { SpecialWithdrawn, SpecialWritten, VariantPrice } from './types.ts';

/** A `datetime-local` value ("2026-10-20T01:00") read as a UTC instant, or null when it is not one. */
export function utcInstantOf(text: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (match === null) return null;
  const iso = `${match[1] as string}:${match[2] ?? '00'}Z`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** The special price of one variant: what runs, is scheduled or is held, and a form to set or end it. */
export function SpecialPrice({
  offerId,
  variant,
  currency,
  canEdit,
  csrfToken,
  version,
  onVersion,
}: {
  readonly offerId: string;
  readonly variant: VariantPrice;
  readonly currency: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** The series version the screen knows; the regular price form shares it. */
  readonly version: number | null;
  readonly onVersion: (version: number) => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [amountText, setAmountText] = useState('');
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const base = `pricing/seller/offers/${offerId}/variants/${variant.variantId}/special-price`;
  const { special, heldSpecial } = variant;

  function fail(failure: Parameters<typeof priceProblemOf>[0]) {
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const problem = priceProblemOf(failure);
    setError(t(`price.error.${problem}`));
    if (problem === 'stale') router.refresh();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || version === null) return;
    const amount = minorOf(amountText, currency);
    const endsAt = utcInstantOf(endText);
    const startsAt = startText.trim() === '' ? null : utcInstantOf(startText);
    if (amount === null) return setError(t('price.error.invalid'));
    if (endsAt === null || (startText.trim() !== '' && startsAt === null)) {
      return setError(t('price.special.error.date'));
    }
    setPending(true);
    setError(null);
    setDone(null);
    const result = await callApi<SpecialWritten>(
      'PUT',
      base,
      { amount, currency, startsAt, endsAt, expectedVersion: version },
      csrfToken,
    );
    setPending(false);
    if (!result.ok) return fail(result.failure);
    onVersion(result.body.seriesVersion);
    setDone(t(`price.special.saved.${result.body.status}`));
    setAmountText('');
    setStartText('');
    setEndText('');
    router.refresh();
  }

  async function withdraw() {
    if (pending || version === null) return;
    setPending(true);
    setError(null);
    setDone(null);
    const result = await callApi<SpecialWithdrawn>(
      'POST',
      `${base}/withdraw`,
      { expectedVersion: version },
      csrfToken,
    );
    setPending(false);
    if (!result.ok) return fail(result.failure);
    onVersion(result.body.seriesVersion);
    setDone(t('price.special.withdrawn'));
    router.refresh();
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="mb-2 font-semibold">{t('price.special.title')}</h3>
      {special === null && heldSpecial === null ? (
        <p className="mb-2 text-fg-muted">{t('price.special.none')}</p>
      ) : null}
      {special === null ? null : (
        <p className="mb-2 text-fg-muted">
          {t(`price.special.${special.state}`, {
            amount: formatMinor(special.amount, currency),
            from: formatInstant(special.startsAt),
            until: formatInstant(special.endsAt),
          })}
        </p>
      )}
      {heldSpecial === null ? null : (
        <div className="mb-3">
          <Banner tone="attention">
            <p>
              {t('price.special.held', {
                amount: formatMinor(heldSpecial.amount, currency),
                from: formatInstant(heldSpecial.startsAt),
                until: formatInstant(heldSpecial.endsAt),
                since: formatInstant(heldSpecial.submittedAt),
              })}
            </p>
          </Banner>
        </div>
      )}
      {canEdit && version !== null ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            name={`special-${variant.variantId}`}
            label={t('price.special.field', { currency })}
            inputMode="decimal"
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value);
              setDone(null);
            }}
          />
          <TextField
            name={`special-start-${variant.variantId}`}
            type="datetime-local"
            label={t('price.special.start')}
            help={t('price.special.start-help')}
            value={startText}
            onChange={(event) => setStartText(event.target.value)}
          />
          <TextField
            name={`special-end-${variant.variantId}`}
            type="datetime-local"
            label={t('price.special.end')}
            value={endText}
            error={error ?? undefined}
            onChange={(event) => setEndText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="secondary"
              loading={pending}
              disabled={pending || amountText.trim() === '' || endText === ''}
            >
              {t('price.special.save')}
            </Button>
            {special === null && heldSpecial === null ? null : (
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => void withdraw()}
              >
                {t(
                  heldSpecial !== null && special === null
                    ? 'price.special.cancel'
                    : 'price.special.end-now',
                )}
              </Button>
            )}
          </div>
          {done === null ? null : <span className="text-sm text-fg-muted">{done}</span>}
        </form>
      ) : null}
    </div>
  );
}
