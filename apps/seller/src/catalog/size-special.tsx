'use client';

import { Badge, Banner, Button, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatMinor } from '../price/money.ts';
import { formatInZone } from '../price/zone-time.ts';
import type { VariantPrice } from '../price/types.ts';
import { EMPTY_SPECIAL, isSpecialTyped, type SpecialDraft } from './variants-table-logic.ts';

/**
 * The special price of one size, in the Price tab of its Details (Offer page PR 6): what runs, is
 * scheduled or waits for review, a button that ends it, and fields to set a new one. The fields
 * are drafts of the table: closing the row keeps them, and the table's "Save N changes" sends
 * them with the prices and stock. Only ending a special is its own button, as it changes nothing
 * the seller typed.
 */
export function SizeSpecial({
  id,
  sizeLabel,
  price,
  currency,
  zone,
  hasRegular,
  canEdit,
  draft,
  errors,
  ending,
  disabled,
  statusError,
  onDraft,
  onEnd,
}: {
  readonly id: string;
  readonly sizeLabel: string;
  readonly price: VariantPrice | null;
  readonly currency: string;
  /** The seller's IANA zone: times are typed and shown in it. */
  readonly zone: string;
  /** The size has a regular price, saved or typed: a special can only go below one. */
  readonly hasRegular: boolean;
  readonly canEdit: boolean;
  readonly draft: SpecialDraft | undefined;
  /** Messages under the amount, the start and the end. */
  readonly errors: {
    readonly amount?: string | undefined;
    readonly start?: string | undefined;
    readonly end?: string | undefined;
  };
  /** The end request is running. */
  readonly ending: boolean;
  /** The table is saving: nothing else is sent meanwhile. */
  readonly disabled: boolean;
  /** Why the last End was refused, or null. */
  readonly statusError: string | null;
  readonly onDraft: (draft: SpecialDraft) => void;
  readonly onEnd: () => void;
}) {
  const t = useTranslations('catalog.size-details.special');
  const locale = useLocale();
  const money = (amount: string) => formatMinor(amount, currency, locale);
  const special = price?.special ?? null;
  const held = price?.heldSpecial ?? null;
  const retired = price?.retired === true;
  const value = draft ?? EMPTY_SPECIAL;
  const set = (patch: Partial<SpecialDraft>) => onDraft({ ...value, ...patch });
  const editable = canEdit && !retired;
  const endKey = special !== null ? `end.${special.state}` : 'end.held';
  // A current special shows as one line; its replace fields open on request, and stay open while
  // something is typed in them or one of them has a message.
  const [replacing, setReplacing] = useState(false);
  const typed = isSpecialTyped(value);
  const hasError = Object.values(errors).some((message) => message !== undefined);
  const showFields = special === null || replacing || typed || hasError;
  const fieldsId = `${id}-fields`;
  const helpId = `${id}-help`;

  return (
    <section aria-labelledby={`${id}-title`} className="mt-4 flex max-w-xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`${id}-title`} className="font-semibold">
          {t('title')}
        </h4>
        {special !== null ? (
          <Badge tone={special.state === 'running' ? 'success' : 'info'}>
            {t(`state.${special.state}`)}
          </Badge>
        ) : held !== null ? (
          <Badge tone="attention">{t('state.held')}</Badge>
        ) : null}
      </div>
      {special === null && held === null ? (
        <p className="text-sm text-fg-muted">{t('none')}</p>
      ) : null}
      {special === null ? null : (
        <p>
          {t(special.state === 'running' ? 'running' : 'scheduled', {
            amount: money(special.amount),
            starts: formatInZone(special.startsAt, zone, locale),
            ends: formatInZone(special.endsAt, zone, locale),
          })}
        </p>
      )}
      {special?.state === 'running' && price?.inForce != null ? (
        <p className="text-sm text-fg-muted">
          {t('was', { regular: money(price.inForce.amount) })}
        </p>
      ) : null}
      {held === null ? null : (
        <Banner tone="attention">
          <p>
            {t('held', {
              amount: money(held.amount),
              starts: formatInZone(held.startsAt, zone, locale),
              ends: formatInZone(held.endsAt, zone, locale),
            })}
          </p>
        </Banner>
      )}
      {retired && (special !== null || held !== null) ? (
        <p className="text-sm text-fg-muted">{t('retired')}</p>
      ) : null}
      {statusError === null ? null : (
        <div role="alert">
          <Banner tone="critical">{statusError}</Banner>
        </div>
      )}
      {editable && (special !== null || held !== null) ? (
        <div className="flex flex-wrap gap-2">
          {special !== null && hasRegular ? (
            <Button
              type="button"
              variant="secondary"
              aria-expanded={showFields}
              aria-controls={showFields ? fieldsId : undefined}
              disabled={typed || hasError}
              onClick={() => setReplacing(!replacing)}
            >
              {t('replace-open')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            loading={ending}
            disabled={ending || disabled}
            aria-label={t(`${endKey}-for`, { size: sizeLabel })}
            onClick={onEnd}
          >
            {t(endKey)}
          </Button>
        </div>
      ) : null}
      {!editable ? null : !hasRegular ? (
        <p className="text-sm text-fg-muted">{t('needs-regular')}</p>
      ) : !showFields ? null : (
        <fieldset
          id={fieldsId}
          aria-describedby={helpId}
          className="flex min-w-0 flex-col gap-2 border-t border-line pt-3"
        >
          <legend className="float-start w-full pb-1 font-medium">
            {t(special === null ? 'new' : 'replace')}
          </legend>
          <div className="flex flex-wrap items-start gap-3">
            <div className="w-full max-w-40">
              <TextField
                name={`special-${id}`}
                label={t('amount', { currency })}
                aria-label={t('amount-for', { currency, size: sizeLabel })}
                inputMode="decimal"
                value={value.amount}
                error={errors.amount}
                onChange={(event) => set({ amount: event.target.value })}
              />
            </div>
            <div className="w-56">
              <TextField
                name={`special-start-${id}`}
                type="datetime-local"
                label={t('starts')}
                aria-label={t('starts-for', { size: sizeLabel })}
                value={value.start}
                error={errors.start}
                onChange={(event) => set({ start: event.target.value })}
              />
            </div>
            <div className="w-56">
              <TextField
                name={`special-end-${id}`}
                type="datetime-local"
                label={t('ends')}
                aria-label={t('ends-for', { size: sizeLabel })}
                required
                value={value.end}
                error={errors.end}
                onChange={(event) => set({ end: event.target.value })}
              />
            </div>
          </div>
          <p id={helpId} className="text-sm text-fg-muted">
            {t(special === null ? 'help' : 'replace-help')}
          </p>
        </fieldset>
      )}
    </section>
  );
}
