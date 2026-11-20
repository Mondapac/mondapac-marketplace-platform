'use client';

import { Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { SellerPicker } from './seller-names.tsx';
import type { AttributionFilterKey, AttributionFilters } from './attributions-types.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Draft = Record<AttributionFilterKey, string>;

const draftOf = (filters: AttributionFilters): Draft => ({
  sellerId: filters.sellerId ?? '',
  status: filters.status ?? '',
  rejectReason: filters.rejectReason ?? '',
  flag: filters.flag ?? '',
  attributedFrom: filters.attributedFrom ?? '',
  attributedTo: filters.attributedTo ?? '',
});

/**
 * The filter panel of the attributions list: store (a picker), status, reject reason, flag and
 * the attribution days. The API reads the days in the admin's panel time zone (else the Market's),
 * and the panel says so.
 */
export function AttributionsFilterPanel({
  filters,
  sellerName,
  csrfToken,
  canPickSeller,
  sellerLabel,
  onSellerChosen,
  onApply,
  close,
}: {
  readonly filters: AttributionFilters;
  /** The name of the store already chosen, when known. */
  readonly sellerName: string | null;
  readonly csrfToken: string;
  /** The admin holds the sellers read key: the store picker shows only then. */
  readonly canPickSeller: boolean;
  /** The chosen store as text (name or short id), for a panel without the picker. */
  readonly sellerLabel: string | null;
  /** A store was picked: its name is kept for the chip. */
  readonly onSellerChosen: (sellerId: string, name: string) => void;
  readonly onApply: (filters: AttributionFilters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('customers.attributions.filter');
  const [draft, setDraft] = useState<Draft>(() => draftOf(filters));
  const [pickedName, setPickedName] = useState<string | null>(sellerName);
  const [errors, setErrors] = useState<Partial<Record<AttributionFilterKey, string>>>({});
  const set = (key: AttributionFilterKey, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const problems: Partial<Record<AttributionFilterKey, string>> = {};
    for (const key of ['sellerId', 'status', 'rejectReason', 'flag'] as const) {
      if (draft[key] !== '') next[key] = draft[key];
    }
    for (const key of ['attributedFrom', 'attributedTo'] as const) {
      const value = draft[key].trim();
      if (value === '') continue;
      if (DAY.test(value)) next[key] = value;
      else problems[key] = t('error.day');
    }
    const from = next['attributedFrom'];
    const to = next['attributedTo'];
    if (from !== undefined && to !== undefined && to < from)
      problems['attributedTo'] = t('error.range');
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }
    if (next['sellerId'] !== undefined && pickedName !== null) {
      onSellerChosen(next['sellerId'], pickedName);
    }
    onApply(next);
    close();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('title')}</h2>
      {canPickSeller ? (
        <SellerPicker
          label={t('name.sellerId')}
          value={draft.sellerId}
          name={pickedName}
          csrfToken={csrfToken}
          onChange={(id, name) => {
            set('sellerId', id);
            setPickedName(name);
          }}
        />
      ) : sellerLabel === null ? null : (
        <p className="text-sm text-fg-secondary">
          {t('name.sellerId')}: {sellerLabel}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('name.status')}
          value={draft.status}
          placeholder={t('any')}
          options={[
            { value: 'active', label: t('status.active') },
            { value: 'rejected', label: t('status.rejected') },
          ]}
          onChange={(event) => set('status', event.target.value)}
        />
        <Select
          label={t('name.rejectReason')}
          value={draft.rejectReason}
          placeholder={t('any')}
          options={[
            { value: 'seller-team', label: t('reason.seller-team') },
            { value: 'admin', label: t('reason.admin') },
          ]}
          onChange={(event) => set('rejectReason', event.target.value)}
        />
        <Select
          label={t('name.flag')}
          value={draft.flag}
          placeholder={t('any')}
          options={[{ value: 'link-burst', label: t('flag.link-burst') }]}
          onChange={(event) => set('flag', event.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">{t('name.attributed')}</legend>
        <p className="text-sm text-fg-muted">{t('zone-days')}</p>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t('from')}
            type="date"
            value={draft.attributedFrom}
            error={errors.attributedFrom}
            onChange={(event) => set('attributedFrom', event.target.value)}
          />
          <TextField
            label={t('to')}
            type="date"
            value={draft.attributedTo}
            error={errors.attributedTo}
            onChange={(event) => set('attributedTo', event.target.value)}
          />
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}
