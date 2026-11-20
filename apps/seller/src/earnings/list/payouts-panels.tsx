'use client';

import {
  ListColumnsPanel,
  ListFilterPanel,
  ListSortPanel,
  RadioGroup,
  type ListFilterField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { numberFormat } from '../../shared/intl.ts';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OptionalColumn,
} from './payouts-columns.ts';
import {
  AMOUNT_STEPS,
  PAYOUT_PRESETS,
  defaultDirection,
  filtersOf,
  type Direction,
  type Filters,
  type Sort,
} from './payouts-list-types.ts';
import type { ListPaging } from '../payout-types.ts';

/** A whole-unit step in the list's currency, with no decimals ("$500"). */
export function stepLabel(step: string, currency: string, locale: string): string {
  return numberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    Number(step),
  );
}

/**
 * The filter builder: Payout on (a day preset, read on the store's clock, with two forward ones),
 * and the amount at least and at most (fixed whole-unit steps of the list's currency). The status
 * is a view, so it is not a filter.
 */
export function PayoutsFilterPanel({
  filters,
  currency,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly currency: string;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('payouts.list');
  const locale = useLocale();
  const steps = AMOUNT_STEPS.map((value) => ({
    value,
    label: stepLabel(value, currency, locale),
  }));
  const fields: ListFilterField[] = [
    {
      id: 'payoutOn',
      label: t('filter.name.payoutOn'),
      options: PAYOUT_PRESETS.map((value) => ({ value, label: t(`date-preset.${value}`) })),
    },
    { id: 'minAmount', label: t('filter.name.minAmount'), options: steps },
    { id: 'maxAmount', label: t('filter.name.maxAmount'), options: steps },
  ];
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: t('filter.title'),
        matchAll: t('filter.match-all'),
        field: t('filter.field'),
        fieldPlaceholder: t('filter.field-placeholder'),
        is: t('filter.is'),
        value: t('filter.value'),
        valuePlaceholder: t('filter.value-placeholder'),
        remove: t('filter.remove'),
        add: t('filter.add'),
        cancel: t('filter.cancel'),
        apply: t('filter.apply'),
      }}
      onApply={(values) => onApply(filtersOf(values))}
      close={close}
    />
  );
}

/**
 * The sort menu. Page numbers: a field (Payout on, Amount, and Created on once that column is
 * shown) and a direction. Previous and next walks the API's cursor, which only goes latest first
 * and has no amount sort, so it is one choice of field with the direction in its name.
 */
export function PayoutsSortPanel({
  sort,
  direction,
  paging,
  createdShown,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly paging: ListPaging;
  /** The Created on column is shown: its sort is offered (secondary, as the design says). */
  readonly createdShown: boolean;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('payouts.list.sort');
  const fields = (['slot', 'amount', 'created'] as const).filter(
    (field) =>
      (field !== 'amount' || paging === 'pages') &&
      (field !== 'created' || createdShown || sort === 'created'),
  );
  if (paging === 'prev-next') {
    return (
      <RadioGroup
        legend={t('by')}
        name="payouts-sort"
        value={sort === 'created' ? 'created' : 'slot'}
        options={fields.map((field) => ({
          value: field,
          label: `${t(`field.${field}`)}: ${t(`${field}.first`)}`,
        }))}
        onChange={(value) => onChange(value as Sort, defaultDirection())}
      />
    );
  }
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={fields.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={() => defaultDirection()}
      orderLabels={(value) => [t(`${value as Sort}.first`), t(`${value as Sort}.second`)]}
      labels={{ by: t('by'), order: t('order') }}
      name="payouts-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}

/** The column picker: Payout on and Status are always shown, the rest can be hidden and moved. */
export function PayoutsColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('payouts.list');
  const ts = useTranslations('payouts.list.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={(['payoutOn', 'status'] as const).map((id) => ({ id, label: t(`col.${id}`) }))}
      optionalLabel={(column) => t(`col.${column as OptionalColumn}`)}
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
