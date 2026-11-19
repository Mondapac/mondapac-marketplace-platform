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
  defaultDirection,
  filtersFor,
  type Direction,
  type Filters,
  type OptionalColumn,
  type Sort,
} from './seller-list-query.ts';
import { KINDS, type Tab } from './types.ts';

/**
 * The filter builder: the submission kind (awaiting review), the outside-the-area switch
 * (incomplete) and the service area (every tab read from the seller files). The identity state
 * tabs have no filter, so the page does not offer this panel there.
 */
export function SellersFilterPanel({
  view,
  filters,
  areas,
  onApply,
  close,
}: {
  readonly view: Tab;
  readonly filters: Filters;
  readonly areas: readonly { readonly code: string; readonly name: string }[];
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('sellers.list.filter');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    ...(view === 'awaiting-review'
      ? [
          {
            id: 'kind',
            label: t('name.kind'),
            options: KINDS.map((value) => ({ value, label: t(`kind.${value}`) })),
          },
        ]
      : []),
    ...(view === 'incomplete'
      ? [
          {
            id: 'outsideArea',
            label: t('name.outsideArea'),
            options: [{ value: 'true', label: t('outside-area-yes') }],
          },
        ]
      : []),
    ...(areas.length > 1
      ? [
          {
            id: 'areaCode',
            label: t('name.areaCode'),
            options: areas.map((area) => ({ value: area.code, label: area.name })),
          },
        ]
      : []),
  ];
  return (
    <ListFilterPanel
      fields={fields}
      values={filtersFor(view, filters)}
      labels={{
        title: t('title'),
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
      onApply={(values) =>
        onApply(
          filtersFor(view, {
            ...(values['kind'] === undefined || values['kind'] === ''
              ? {}
              : { kind: values['kind'] }),
            ...(values['outsideArea'] === 'true' ? { outsideArea: 'true' } : {}),
            ...(values['areaCode'] === undefined || values['areaCode'] === ''
              ? {}
              : { areaCode: values['areaCode'] }),
          }),
        )
      }
      close={close}
    />
  );
}

/** The sort menu (tabs read from the seller files): the tab's own order or the store name. */
export function SellersSortPanel({
  view,
  sort,
  direction,
  onChange,
}: {
  readonly view: Tab;
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('sellers.list.sort');
  return (
    <ListSortPanel
      name="sellers-sort"
      sort={sort}
      direction={direction}
      fields={(['queue', 'name'] as const).map((value) => ({
        id: value,
        label: t(`field.${value}`),
      }))}
      defaultDirection={(value) => defaultDirection(value as Sort, view)}
      orderLabels={(value) => {
        const kind = value === 'name' ? 'name' : view === 'awaiting-review' ? 'oldest' : 'newest';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}

/** The column picker: the store is always shown, the rest can be hidden, shown and moved. */
export function SellersColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('sellers.list');
  const ts = useTranslations('sales-lists.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={[{ id: 'store', label: t('col.store') }]}
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
