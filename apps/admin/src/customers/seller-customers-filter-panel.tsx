'use client';

import { Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { majorOf } from './customers-filter-panel.tsx';
import {
  minorOfTyped,
  type SellerFilterKey,
  type SellerFilters,
} from './seller-customers-types.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNT = /^\d{1,7}$/;

type Draft = Record<SellerFilterKey, string>;

const draftOf = (filters: SellerFilters, currency: string | null): Draft => ({
  follower: filters.follower ?? '',
  exclusive: filters.exclusive ?? '',
  lastOrderFrom: filters.lastOrderFrom ?? '',
  lastOrderTo: filters.lastOrderTo ?? '',
  ordersMin: filters.ordersMin ?? '',
  ordersMax: filters.ordersMax ?? '',
  spentMin:
    filters.spentMin === undefined || currency === null ? '' : majorOf(filters.spentMin, currency),
  spentMax:
    filters.spentMax === undefined || currency === null ? '' : majorOf(filters.spentMax, currency),
});

/**
 * The filter panel of a seller's customers (phase 3): follower and exclusive as choices, then the
 * last order as a day range, the order count and spent as ranges. Spent is typed in the Market's
 * currency (the one the rows carry) and sent in minor units; without a known currency the spent
 * fields are left out and a bound already set is kept.
 */
export function SellerCustomersFilterPanel({
  filters,
  currency,
  onApply,
  close,
}: {
  readonly filters: SellerFilters;
  readonly currency: string | null;
  readonly onApply: (filters: SellerFilters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('customers.seller-tab.list.filter');
  const [draft, setDraft] = useState<Draft>(() => draftOf(filters, currency));
  const [errors, setErrors] = useState<Partial<Record<SellerFilterKey, string>>>({});
  const set = (key: SellerFilterKey, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const problems: Partial<Record<SellerFilterKey, string>> = {};
    if (draft.follower !== '') next['follower'] = draft.follower;
    if (draft.exclusive !== '') next['exclusive'] = draft.exclusive;
    for (const key of ['lastOrderFrom', 'lastOrderTo'] as const) {
      const value = draft[key].trim();
      if (value === '') continue;
      if (DAY.test(value)) next[key] = value;
      else problems[key] = t('error.day');
    }
    for (const key of ['ordersMin', 'ordersMax'] as const) {
      const value = draft[key].trim();
      if (value === '') continue;
      if (COUNT.test(value)) next[key] = String(Number(value));
      else problems[key] = t('error.count');
    }
    for (const key of ['spentMin', 'spentMax'] as const) {
      if (currency === null) {
        const kept = filters[key];
        if (kept !== undefined) next[key] = kept;
        continue;
      }
      const value = draft[key].trim();
      if (value === '') continue;
      const minor = minorOfTyped(value, currency);
      if (minor === null) problems[key] = t('error.amount');
      else next[key] = minor;
    }
    const before = (from: SellerFilterKey, to: SellerFilterKey, numeric: boolean) => {
      const start = next[from];
      const end = next[to];
      if (start === undefined || end === undefined) return;
      if (numeric ? BigInt(end) < BigInt(start) : end < start) problems[to] = t('error.range');
    };
    before('lastOrderFrom', 'lastOrderTo', false);
    before('ordersMin', 'ordersMax', true);
    before('spentMin', 'spentMax', true);
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }
    onApply(next);
    close();
  }

  const range = (
    from: SellerFilterKey,
    to: SellerFilterKey,
    type: 'date' | 'text',
    legend: string,
    mode?: 'numeric' | 'decimal',
  ) => (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('from')}
          type={type}
          {...(mode === undefined ? {} : { inputMode: mode })}
          value={draft[from]}
          error={errors[from]}
          onChange={(event) => set(from, event.target.value)}
        />
        <TextField
          label={t('to')}
          type={type}
          {...(mode === undefined ? {} : { inputMode: mode })}
          value={draft[to]}
          error={errors[to]}
          onChange={(event) => set(to, event.target.value)}
        />
      </div>
    </fieldset>
  );

  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('name.follower')}
          value={draft.follower}
          placeholder={t('any')}
          options={[
            { value: 'yes', label: t('yes') },
            { value: 'no', label: t('no') },
          ]}
          onChange={(event) => set('follower', event.target.value)}
        />
        <Select
          label={t('name.exclusive')}
          value={draft.exclusive}
          placeholder={t('any')}
          options={[
            { value: 'yes', label: t('yes') },
            { value: 'no', label: t('no') },
          ]}
          onChange={(event) => set('exclusive', event.target.value)}
        />
      </div>
      {range('lastOrderFrom', 'lastOrderTo', 'date', t('name.lastOrder'))}
      {range('ordersMin', 'ordersMax', 'text', t('name.orders'), 'numeric')}
      {currency === null
        ? null
        : range('spentMin', 'spentMax', 'text', t('name.spent', { currency }), 'decimal')}
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}
