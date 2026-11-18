'use client';

import { Button, ListColumnsPanel, ListSortPanel, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { inputOf, minorOf } from '../price/money.ts';
import { DEFAULT_COLUMNS, OPTIONAL_COLUMNS, cleanColumns, type CustomerColumn } from './columns.ts';
import {
  SORT_FIELDS,
  defaultDirection,
  type Direction,
  type FilterKey,
  type Filters,
  type SortField,
} from './query.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNT = /^\d{1,7}$/;
/** The API takes a spent bound of at most 15 minor-unit digits. */
const MINOR_DIGITS_MAX = 15;

type Draft = Record<FilterKey, string>;

const draftOf = (filters: Filters, currency: string | null): Draft => {
  const spent = (value: string | undefined) =>
    value === undefined || currency === null ? '' : inputOf(value, currency);
  return {
    follower: filters.follower ?? '',
    exclusive: filters.exclusive ?? '',
    lastOrderFrom: filters.lastOrderFrom ?? '',
    lastOrderTo: filters.lastOrderTo ?? '',
    ordersMin: filters.ordersMin ?? '',
    ordersMax: filters.ordersMax ?? '',
    spentMin: spent(filters.spentMin),
    spentMax: spent(filters.spentMax),
  };
};

/**
 * The filter panel: Follower and Exclusive as choices, Last order as a day range, Orders and Spent
 * as ranges. Spent is typed in the currency the list shows and sent in minor units; with no known
 * currency (no row has one yet) the Spent fields are left out and a bound already set is kept. A
 * range that ends before it starts is refused here, as the API would refuse it.
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
  const t = useTranslations('customers.filter');
  const [draft, setDraft] = useState<Draft>(() => draftOf(filters, currency));
  const [errors, setErrors] = useState<Partial<Record<FilterKey, string>>>({});
  const set = (key: FilterKey, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const problems: Partial<Record<FilterKey, string>> = {};
    for (const key of ['follower', 'exclusive'] as const) {
      if (draft[key] !== '') next[key] = draft[key];
    }
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
        // The fields are not shown without a currency: a bound already set stays.
        const kept = filters[key];
        if (kept !== undefined) next[key] = kept;
        continue;
      }
      const value = draft[key].trim();
      if (value === '') continue;
      if (/^0+(\.0+)?$/.test(value)) {
        next[key] = '0';
        continue;
      }
      const minor = minorOf(value, currency);
      if (minor === null) problems[key] = t('error.amount');
      else if (minor.length > MINOR_DIGITS_MAX) problems[key] = t('error.amount-large');
      else next[key] = minor;
    }
    const backwards = (from: FilterKey, to: FilterKey, numeric: boolean) => {
      const start = next[from];
      const end = next[to];
      if (start === undefined || end === undefined) return;
      if (numeric ? BigInt(end) < BigInt(start) : end < start) problems[to] = t('error.range');
    };
    backwards('lastOrderFrom', 'lastOrderTo', false);
    backwards('ordersMin', 'ordersMax', true);
    backwards('spentMin', 'spentMax', true);
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
    legend: string,
    mode?: 'numeric' | 'decimal',
    disabled = false,
  ) => (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('from')}
          type={type}
          {...(mode === undefined ? {} : { inputMode: mode })}
          value={draft[from]}
          disabled={disabled}
          error={errors[from]}
          onChange={(event) => set(from, event.target.value)}
        />
        <TextField
          label={t('to')}
          type={type}
          {...(mode === undefined ? {} : { inputMode: mode })}
          value={draft[to]}
          disabled={disabled}
          error={errors[to]}
          onChange={(event) => set(to, event.target.value)}
        />
      </div>
    </fieldset>
  );
  const yesNo = [
    { value: 'yes', label: t('yes') },
    { value: 'no', label: t('no') },
  ];
  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('name.follower')}
          value={draft.follower}
          placeholder={t('any')}
          options={yesNo}
          onChange={(event) => set('follower', event.target.value)}
        />
        <Select
          label={t('name.exclusive')}
          value={draft.exclusive}
          placeholder={t('any')}
          options={yesNo}
          onChange={(event) => set('exclusive', event.target.value)}
        />
      </div>
      {range('lastOrderFrom', 'lastOrderTo', 'date', t('name.lastOrder'))}
      {range('ordersMin', 'ordersMax', 'text', t('name.orders'), 'numeric')}
      {range(
        'spentMin',
        'spentMax',
        'text',
        currency === null ? t('name.spent-plain') : t('name.spent', { currency }),
        'decimal',
        currency === null,
      )}
      {currency === null ? <p className="text-sm text-fg-muted">{t('spent-wait')}</p> : null}
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}

/** The sort menu: one field and the direction, applied as they are chosen. */
export function CustomersSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: SortField;
  readonly direction: Direction;
  readonly onChange: (sort: SortField, direction: Direction) => void;
}) {
  const t = useTranslations('customers.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORT_FIELDS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as SortField)}
      orderLabels={(value) => {
        const kind =
          value === 'code' ? 'text' : value === 'orders' || value === 'spent' ? 'amount' : 'date';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="customers-sort"
      onChange={(value, next) => onChange(value as SortField, next)}
    />
  );
}

/** The column picker: the code is always shown, the rest can be hidden, shown and moved. */
export function CustomersColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly CustomerColumn[];
  readonly onSave: (columns: readonly CustomerColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('customers');
  const ts = useTranslations('customers.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={[{ id: 'code', label: t('col.code') }]}
      optionalLabel={(column) => t(`col.${column as CustomerColumn}`)}
      labels={{
        title: ts('title'),
        help: ts('help'),
        always: ts('always'),
        up: (column) => ts('up', { column }),
        down: (column) => ts('down', { column }),
        reset: ts('reset'),
        save: ts('save'),
      }}
      onSave={(next) => onSave(cleanColumns(next))}
      close={close}
    />
  );
}
