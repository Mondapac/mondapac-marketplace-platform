'use client';

import {
  ListColumnsPanel,
  ListFilterPanel,
  ListSortPanel,
  type ListFilterField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  SORTS,
  cleanColumns,
  defaultDirection,
  filtersOf,
  type Direction,
  type Filters,
  type OptionalColumn,
  type Sort,
} from './list-types.ts';

/**
 * The filter builder: Type (the certification types the admin may read) and Submitted (a date
 * preset, worked out on the clock of the list's zone). Without the types there is no Type field.
 */
export function RequestsFilterPanel({
  filters,
  typeNames,
  onApply,
  close,
}: {
  readonly filters: Filters;
  /** Type code to name; empty when the admin may not read the types. */
  readonly typeNames: Readonly<Record<string, string>>;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('certificates.requests');
  const ts = useTranslations('sales-lists');
  const types = Object.entries(typeNames).map(([value, label]) => ({ value, label }));
  const fields: ListFilterField[] = [
    ...(types.length === 0 && filters.type === undefined
      ? []
      : [
          {
            id: 'type',
            label: t('filter.name.type'),
            options:
              filters.type === undefined || typeNames[filters.type] !== undefined
                ? types
                : [...types, { value: filters.type, label: filters.type }],
          },
        ]),
    {
      id: 'submitted',
      label: t('filter.name.submitted'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
  ];
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: t('filter.title'),
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

/** The sort menu: Submitted (oldest first by default) or Type (A to Z), applied as chosen. */
export function RequestsSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('certificates.requests.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={() => defaultDirection()}
      orderLabels={(value) => [t(`${value as Sort}.first`), t(`${value as Sort}.second`)]}
      labels={{ by: t('by'), order: t('order') }}
      name="issuer-requests-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}

/** The column picker: Seller, Type and Submitted are always shown, the rest can be moved or hidden. */
export function RequestsColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('certificates.requests');
  const ts = useTranslations('sales-lists.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={(['seller', 'type', 'submitted'] as const).map((id) => ({
        id,
        label: t(`col.${id}`),
      }))}
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
