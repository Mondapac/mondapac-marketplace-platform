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
  FILTER_FIELDS,
  OPTIONAL_COLUMNS,
  SORTS,
  STATUSES,
  defaultDirection,
  type CategoryTree,
  type Direction,
  type FilterField,
  type Filters,
  type OptionalColumn,
  type Sort,
  type Status,
} from './products-list-types.ts';

const FIXED = ['product', 'status', 'category'] as const;

/** The column picker of the seller list, in the seller's words (the picker is the shared one). */
export function ProductsColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('catalog.products.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={FIXED.map((id) => ({ id, label: t(`fixed.${id}`) }))}
      optionalLabel={(column) => t(`optional.${column as OptionalColumn}`)}
      labels={{
        title: t('title'),
        help: t('help'),
        always: t('always'),
        up: (column) => t('up', { column }),
        down: (column) => t('down', { column }),
        reset: t('reset'),
        save: t('save'),
      }}
      onSave={(next) => onSave(next as readonly OptionalColumn[])}
      close={close}
    />
  );
}

/** The sort menu of the seller list: Name, Last changed (default) and Created. */
export function ProductsSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('catalog.products.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as Sort)}
      orderLabels={(value) => {
        const kind = value === 'name' ? 'name' : 'date';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="seller-products-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}

/**
 * The filter builder of the seller list: Status, Category, Paused and Product type. A field whose
 * values did not load (the category tree, the Market's product types) is left out.
 */
export function ProductsFilterPanel({
  filters,
  categories,
  productTypes,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly categories: CategoryTree['categories'];
  readonly productTypes: readonly string[];
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('catalog.products.filter');
  const ts = useTranslations('catalog.products');
  const options = (field: FilterField): ListFilterField['options'] => {
    switch (field) {
      case 'status':
        return STATUSES.map((value) => ({ value, label: ts(`status.${value}`) }));
      case 'categoryId':
        return categories.map((category) => ({
          value: category.id,
          label: `${'– '.repeat(category.depth)}${category.name}`,
        }));
      case 'paused':
        return [
          { value: 'true', label: t('paused.true') },
          { value: 'false', label: t('paused.false') },
        ];
      case 'typeCode':
        return productTypes.map((value) => ({ value, label: value }));
    }
  };
  const fields: ListFilterField[] = FILTER_FIELDS.map((field) => ({
    id: field,
    label: t(`name.${field}`),
    options: options(field),
  })).filter((field) => field.options.length > 0);
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: t('title'),
        matchAll: t('match-all'),
        field: t('field'),
        fieldPlaceholder: t('field-placeholder'),
        is: t('is'),
        value: t('value'),
        valuePlaceholder: t('value-placeholder'),
        remove: t('remove'),
        add: t('add'),
        cancel: t('cancel'),
        apply: t('apply'),
      }}
      onApply={(values) => {
        const next: {
          status?: Status;
          categoryId?: string;
          paused?: 'true' | 'false';
          typeCode?: string;
        } = {};
        if (values['status'] !== undefined) next.status = values['status'] as Status;
        if (values['categoryId'] !== undefined) next.categoryId = values['categoryId'];
        if (values['paused'] !== undefined) next.paused = values['paused'] as 'true' | 'false';
        if (values['typeCode'] !== undefined) next.typeCode = values['typeCode'];
        onApply(next);
      }}
      close={close}
    />
  );
}
