'use client';

import { Banner, Button, TextField, toast, type SectionResult } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type RefObject } from 'react';
import { usePricePart } from './price-bar.tsx';
import { callApi } from '../api/client.ts';
import { priceProblemOf } from './errors.ts';
import { formatMinor, minorOf } from './money.ts';
import { formatInZone, instantOfZoned } from './zone-time.ts';
import type { SpecialWithdrawn, SpecialWritten, VariantPrice } from './types.ts';

/**
 * The special price of one variant: what runs, is scheduled or is held, and fields to set one,
 * saved by the page's save bar. Ending or cancelling a special stays its own button.
 */
export function SpecialPrice({
  offerId,
  variant,
  currency,
  canEdit,
  csrfToken,
  zone,
  version,
  versionRef,
  onVersion,
}: {
  readonly offerId: string;
  readonly variant: VariantPrice;
  readonly currency: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** The seller's IANA zone: times are typed and shown in it. */
  readonly zone: string;
  /** The series version the screen knows; the regular price form shares it. */
  readonly version: number | null;
  /** The same version, read when a save runs (the regular price may have moved it in the run). */
  readonly versionRef: RefObject<number | null>;
  readonly onVersion: (version: number) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [amountText, setAmountText] = useState('');
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `pricing/seller/offers/${offerId}/variants/${variant.variantId}/special-price`;
  const { special, heldSpecial } = variant;

  /** Shows a refused write; a 401 leaves for the session-ended page and ends the run. */
  function fail(failure: Parameters<typeof priceProblemOf>[0]): SectionResult {
    if (failure.status === 401) return part.signedOut();
    const problem = priceProblemOf(failure);
    setError(t(`price.error.${problem}`));
    if (problem === 'stale') router.refresh();
    return 'failed';
  }

  const parsed = () => {
    const amount = minorOf(amountText, currency);
    const endsAt = instantOfZoned(endText, zone);
    const startsAt = startText.trim() === '' ? null : instantOfZoned(startText, zone);
    if (amount === null) return { ok: false, error: t('price.error.invalid') } as const;
    if (endsAt === null || (startText.trim() !== '' && startsAt === null)) {
      return { ok: false, error: t('price.special.error.date') } as const;
    }
    return { ok: true, amount, startsAt, endsAt } as const;
  };

  function check(): boolean {
    const next = parsed();
    setError(next.ok ? null : next.error);
    return next.ok;
  }

  async function save(): Promise<SectionResult> {
    const next = parsed();
    if (!next.ok || versionRef.current === null) return 'failed';
    setError(null);
    const result = await callApi<SpecialWritten>(
      'PUT',
      base,
      {
        amount: next.amount,
        currency,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        expectedVersion: versionRef.current,
      },
      csrfToken,
    );
    if (!result.ok) return fail(result.failure);
    onVersion(result.body.seriesVersion);
    part.note({
      message: t(`price.special.saved.${result.body.status}`),
      tone: result.body.status === 'accepted' ? 'success' : 'info',
    });
    setAmountText('');
    setStartText('');
    setEndText('');
    router.refresh();
    return 'saved';
  }

  const editable = canEdit && version !== null;
  const part = usePricePart(`${variant.variantId}:special`, {
    dirty: editable && (amountText.trim() !== '' || startText !== '' || endText !== ''),
    check,
    save,
    discard: () => {
      setAmountText('');
      setStartText('');
      setEndText('');
      setError(null);
    },
  });

  async function withdraw() {
    if (pending || part.saving || versionRef.current === null) return;
    setPending(true);
    setError(null);
    const result = await callApi<SpecialWithdrawn>(
      'POST',
      `${base}/withdraw`,
      { expectedVersion: versionRef.current },
      csrfToken,
    );
    setPending(false);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    onVersion(result.body.seriesVersion);
    toast.success(t('price.special.withdrawn'));
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
            amount: formatMinor(special.amount, currency, locale),
            from: formatInZone(special.startsAt, zone, locale),
            until: formatInZone(special.endsAt, zone, locale),
          })}
        </p>
      )}
      {heldSpecial === null ? null : (
        <div className="mb-3">
          <Banner tone="attention">
            <p>
              {t('price.special.held', {
                amount: formatMinor(heldSpecial.amount, currency, locale),
                from: formatInZone(heldSpecial.startsAt, zone, locale),
                until: formatInZone(heldSpecial.endsAt, zone, locale),
                since: formatInZone(heldSpecial.submittedAt, zone, locale),
              })}
            </p>
          </Banner>
        </div>
      )}
      {editable ? (
        <div className="flex flex-col gap-3">
          <TextField
            name={`special-${variant.variantId}`}
            label={t('price.special.field', { currency })}
            inputMode="decimal"
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value);
              setError(null);
            }}
          />
          <TextField
            name={`special-start-${variant.variantId}`}
            type="datetime-local"
            label={t('price.special.start', { zone })}
            help={t('price.special.start-help', { zone })}
            value={startText}
            onChange={(event) => {
              setStartText(event.target.value);
              setError(null);
            }}
          />
          <TextField
            name={`special-end-${variant.variantId}`}
            type="datetime-local"
            label={t('price.special.end', { zone })}
            value={endText}
            error={error ?? undefined}
            onChange={(event) => {
              setEndText(event.target.value);
              setError(null);
            }}
          />
          {special === null && heldSpecial === null ? null : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                loading={pending}
                disabled={pending || part.saving}
                onClick={() => void withdraw()}
              >
                {t(
                  heldSpecial !== null && special === null
                    ? 'price.special.cancel'
                    : 'price.special.end-now',
                )}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
