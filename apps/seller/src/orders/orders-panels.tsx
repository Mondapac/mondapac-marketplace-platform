'use client';

import {
  ListColumnsPanel,
  ListFilterPanel,
  ListSortPanel,
  type ListFilterField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OrderColumn,
} from './orders-columns.ts';
import { DATE_PRESETS } from './date-presets.ts';
import {
  FILTER_FIELDS,
  SORT_FIELDS,
  defaultDirection,
  filtersOf,
  type Direction,
  type Filters,
  type SortField,
} from './orders-query.ts';

/** The filter builder: Paid (the day the order was paid, as a preset on the seller's own clock). */
export function OrdersFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('orders');
  const ts = useTranslations('orders.list');
  const fields: ListFilterField[] = FILTER_FIELDS.map((field) => ({
    id: field,
    label: t(`col.${field}`),
    options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
  }));
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: ts('filter.title'),
        matchAll: ts('filter.match-all'),
        field: ts('filter.field'),
        fieldPlaceholder: ts('filter.field-placeholder'),
        is: ts('filter.is'),
        value: ts('filter.value'),
        valuePlaceholder: ts('filter.value-placeholder'),
        remove: ts('filter.remove'),
        add: ts('filter.add'),
        cancel: ts('filter.cancel'),
        apply: ts('filter.apply'),
      }}
      onApply={(values) => onApply(filtersOf(values))}
      close={close}
    />
  );
}

/** The sort menu: one field and the direction, applied as they are chosen. */
export function OrdersSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: SortField;
  readonly direction: Direction;
  readonly onChange: (sort: SortField, direction: Direction) => void;
}) {
  const t = useTranslations('orders.list.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORT_FIELDS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={() => defaultDirection()}
      orderLabels={(value) => {
        const kind = value === 'total' ? 'amount' : 'date';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="orders-sort"
      onChange={(value, next) => onChange(value as SortField, next)}
    />
  );
}

/** The column picker: Order and Status are always shown, the rest can be hidden, shown and moved. */
export function OrdersColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OrderColumn[];
  readonly onSave: (columns: readonly OrderColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('orders');
  const ts = useTranslations('orders.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={(['order', 'status'] as const).map((id) => ({ id, label: t(`col.${id}`) }))}
      optionalLabel={(column) => t(`col.${column as OrderColumn}`)}
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
