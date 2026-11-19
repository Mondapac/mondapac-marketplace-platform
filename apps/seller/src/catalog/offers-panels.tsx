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
  type OfferColumn,
} from './offers-columns.ts';
import {
  SORT_FIELDS,
  STATUSES,
  defaultDirection,
  filtersOf,
  type Direction,
  type Filters,
  type SortField,
} from './offers-query.ts';

/** The filter builder: Status and On sale. */
export function OffersFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('catalog.offers');
  const ts = useTranslations('catalog.offers.list');
  const fields: ListFilterField[] = [
    {
      id: 'status',
      label: t('col.status'),
      options: STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
    },
    {
      id: 'listed',
      label: t('col.listed'),
      options: [
        { value: 'true', label: t('listed.yes') },
        { value: 'false', label: t('listed.no') },
      ],
    },
  ];
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
export function OffersSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: SortField;
  readonly direction: Direction;
  readonly onChange: (sort: SortField, direction: Direction) => void;
}) {
  const t = useTranslations('catalog.offers.list.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORT_FIELDS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(field) => defaultDirection(field as SortField)}
      orderLabels={(value) => {
        const kind = value === 'created' ? 'date' : 'text';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="offers-sort"
      onChange={(value, next) => onChange(value as SortField, next)}
    />
  );
}

/** The column picker: Product and Status are always shown, the rest can be hidden, shown and moved. */
export function OffersColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OfferColumn[];
  readonly onSave: (columns: readonly OfferColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('catalog.offers');
  const ts = useTranslations('catalog.offers.list.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={[
        { id: 'product', label: t('col.product') },
        { id: 'status', label: t('col.status') },
      ]}
      optionalLabel={(column) => t(`col.${column as OfferColumn}`)}
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
