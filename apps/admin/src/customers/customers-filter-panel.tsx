'use client';

import { Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { decimalsOf, parseAmount } from '../wallet/money.ts';
import type { FilterKey, Filters } from './list-types.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNT = /^\d{1,7}$/;
/** The API takes a spent bound of at most 15 minor-unit digits. */
const MINOR_DIGITS_MAX = 15;

/** Minor units as the amount an admin types ("1250" AUD is "12.50"). */
export function majorOf(minor: string, currency: string): string {
  const decimals = decimalsOf(currency) ?? 0;
  if (decimals === 0) return minor;
  const padded = minor.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

type Draft = Record<FilterKey, string>;

const draftOf = (filters: Filters, currency: string | null): Draft => ({
  status: filters.status ?? '',
  verified: filters.verified ?? '',
  joinedFrom: filters.joinedFrom ?? '',
  joinedTo: filters.joinedTo ?? '',
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
 * The filter panel of the Customers list: status and email verified as choices, then joined and
 * last order as day ranges, order count and spent as ranges. Spent is typed in the Market's
 * currency (as the list shows it) and sent in minor units; without a known currency (no row on
 * the page has one) the spent fields are left out, and a bound already set is kept as it is. A range whose end is before its start is refused
 * here, as the API would refuse it.
 */
export function CustomersFilterPanel({
  filters,
  currency,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly currency: string | null;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('customers.list.filter');
  const [draft, setDraft] = useState<Draft>(() => draftOf(filters, currency));
  const [errors, setErrors] = useState<Partial<Record<FilterKey, string>>>({});
  const set = (key: FilterKey, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const problems: Partial<Record<FilterKey, string>> = {};
    if (draft.status !== '') next['status'] = draft.status;
    if (draft.verified !== '') next['verified'] = draft.verified;
    for (const key of ['joinedFrom', 'joinedTo', 'lastOrderFrom', 'lastOrderTo'] as const) {
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
    if (currency !== null) {
      for (const key of ['spentMin', 'spentMax'] as const) {
        const value = draft[key].trim();
        if (value === '') continue;
        if (/^0+(\.0+)?$/.test(value)) {
          next[key] = '0';
          continue;
        }
        const parsed = parseAmount(value, currency);
        if (!parsed.ok) problems[key] = t('error.amount');
        else if (parsed.minor.length > MINOR_DIGITS_MAX) problems[key] = t('error.amount-large');
        else next[key] = parsed.minor;
      }
    } else {
      // The fields are not shown without a currency: a bound already set (a saved filter) stays.
      for (const key of ['spentMin', 'spentMax'] as const) {
        const value = filters[key];
        if (value !== undefined) next[key] = value;
      }
    }
    const before = (from: FilterKey, to: FilterKey, numeric: boolean) => {
      const start = next[from];
      const end = next[to];
      if (start === undefined || end === undefined) return;
      const backwards = numeric ? BigInt(end) < BigInt(start) : end < start;
      if (backwards) problems[to] = t('error.range');
    };
    before('joinedFrom', 'joinedTo', false);
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
    from: FilterKey,
    to: FilterKey,
    type: 'date' | 'text',
    mode?: 'numeric' | 'decimal',
  ) => (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">{t(`name.${from}`)}</legend>
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
          label={t('name.status')}
          value={draft.status}
          placeholder={t('any')}
          options={[
            { value: 'active', label: t('status.active') },
            { value: 'disabled', label: t('status.disabled') },
          ]}
          onChange={(event) => set('status', event.target.value)}
        />
        <Select
          label={t('name.verified')}
          value={draft.verified}
          placeholder={t('any')}
          options={[
            { value: 'yes', label: t('verified.yes') },
            { value: 'no', label: t('verified.no') },
          ]}
          onChange={(event) => set('verified', event.target.value)}
        />
      </div>
      {range('joinedFrom', 'joinedTo', 'date')}
      {range('lastOrderFrom', 'lastOrderTo', 'date')}
      {range('ordersMin', 'ordersMax', 'text', 'numeric')}
      {currency === null ? null : range('spentMin', 'spentMax', 'text', 'decimal')}
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}
