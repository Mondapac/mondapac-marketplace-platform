'use client';

import { Banner, Button, TextField, toast, type SectionResult } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type RefObject } from 'react';
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
  number,
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
  /** The variant's number on the page, read out with each field. */
  readonly number: number;
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
  // A refusal is shown where it belongs: the amount, a date, or the current special (End now).
  const [amountError, setAmountError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const base = `pricing/seller/offers/${offerId}/variants/${variant.variantId}/special-price`;
  const { special, heldSpecial } = variant;

  // A refused End now moves focus to its message, once React has drawn it.
  useEffect(() => {
    if (statusError !== null) statusRef.current?.focus();
  }, [statusError]);

  function clearErrors() {
    setAmountError(null);
    setStartError(null);
    setEndError(null);
    setStatusError(null);
  }

  /** Where a refused set goes: the amount, the dates, or the message above the fields. */
  function showProblem(problem: string) {
    const message = t(`price.error.${problem}`);
    if (AMOUNT_PROBLEMS.has(problem)) setAmountError(message);
    else if (DATE_PROBLEMS.has(problem)) setEndError(message);
    else setStatusError(message);
  }

  const parsed = () => {
    const amount = minorOf(amountText, currency);
    const endsAt = instantOfZoned(endText, zone);
    const startsAt = startText.trim() === '' ? null : instantOfZoned(startText, zone);
    const startBad = startText.trim() !== '' && startsAt === null;
    return { amount, startsAt, endsAt, startBad };
  };

  function check(): boolean {
    const next = parsed();
    clearErrors();
    if (next.amount === null) setAmountError(t('price.error.invalid'));
    if (next.startBad) setStartError(t('price.special.error.start'));
    if (next.endsAt === null) setEndError(t('price.special.error.end'));
    return next.amount !== null && !next.startBad && next.endsAt !== null;
  }

  async function save(): Promise<SectionResult> {
    const next = parsed();
    if (next.amount === null || next.startBad || next.endsAt === null) return 'failed';
    if (versionRef.current === null) return 'failed';
    clearErrors();
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
    if (!result.ok) {
      if (result.failure.status === 401) return part.signedOut();
      const problem = priceProblemOf(result.failure);
      showProblem(problem);
      if (problem === 'stale') router.refresh();
      return 'failed';
    }
    onVersion(result.body.seriesVersion);
    part.note({
      message: t(`price.special.saved.${result.body.status}`),
      kind: result.body.status === 'accepted' ? 'success' : 'review',
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
      clearErrors();
    },
  });

  async function withdraw() {
    if (part.saving || versionRef.current === null) return;
    // The page's Save waits while this runs: both writes use the same series version.
    part.setBusy(true);
    setStatusError(null);
    const result = await callApi<SpecialWithdrawn>(
      'POST',
      `${base}/withdraw`,
      { expectedVersion: versionRef.current },
      csrfToken,
    );
    part.setBusy(false);
    if (!result.ok) {
      if (result.failure.status === 401) {
        part.signedOut();
        return;
      }
      const problem = priceProblemOf(result.failure);
      setStatusError(t(`price.error.${problem}`));
      if (problem === 'stale') router.refresh();
      return;
    }
    onVersion(result.body.seriesVersion);
    toast.success(t('price.special.withdrawn'));
    router.refresh();
  }

  const endable = editable && (special !== null || heldSpecial !== null);
  const variantName = t('price.variant', { number });
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
      {variant.retired && (special !== null || heldSpecial !== null) ? (
        <p className="mb-2 text-sm text-fg-muted">{t('price.special.retired-note')}</p>
      ) : null}
      {statusError === null ? null : (
        <div ref={statusRef} tabIndex={-1} className="mb-3">
          <Banner tone="critical">{statusError}</Banner>
        </div>
      )}
      {/* Ending the current special is its own action, beside what it ends, not under the new one. */}
      {endable ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="destructive"
            loading={part.busy}
            disabled={part.busy || part.saving}
            aria-label={`${t(
              heldSpecial !== null && special === null
                ? 'price.special.cancel'
                : 'price.special.end-now',
            )}, ${variantName}`}
            onClick={() => void withdraw()}
          >
            {t(
              heldSpecial !== null && special === null
                ? 'price.special.cancel'
                : 'price.special.end-now',
            )}
          </Button>
        </div>
      ) : null}
      {editable ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <h4 className="font-medium">{t('price.special.new')}</h4>
          <TextField
            name={`special-${variant.variantId}`}
            label={t('price.special.field', { currency })}
            aria-label={`${t('price.special.field', { currency })}, ${variantName}`}
            inputMode="decimal"
            value={amountText}
            error={amountError ?? undefined}
            onChange={(event) => {
              setAmountText(event.target.value);
              setAmountError(null);
            }}
          />
          <TextField
            name={`special-start-${variant.variantId}`}
            type="datetime-local"
            label={t('price.special.start', { zone })}
            aria-label={`${t('price.special.start', { zone })}, ${variantName}`}
            help={t('price.special.start-help', { zone })}
            value={startText}
            error={startError ?? undefined}
            onChange={(event) => {
              setStartText(event.target.value);
              setStartError(null);
            }}
          />
          <TextField
            name={`special-end-${variant.variantId}`}
            type="datetime-local"
            label={t('price.special.end', { zone })}
            aria-label={`${t('price.special.end', { zone })}, ${variantName}`}
            value={endText}
            error={endError ?? undefined}
            onChange={(event) => {
              setEndText(event.target.value);
              setEndError(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Refusals about the special's amount, shown on the amount field. */
const AMOUNT_PROBLEMS = new Set(['invalid', 'out-of-range', 'not-below', 'no-regular']);
/** Refusals about its dates, shown on the end field. */
const DATE_PROBLEMS = new Set(['window', 'past']);
