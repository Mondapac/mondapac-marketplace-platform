'use client';

import {
  ListColumnsPanel,
  ListFilterPanel,
  ListSortPanel,
  type ListFilterField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DEFAULT_COLUMNS, OPTIONAL_COLUMNS, cleanColumns, type ReviewColumn } from './columns.ts';
import {
  PUBLISHED_WITHIN,
  RATINGS,
  REPLY_FILTERS,
  SORT_FIELDS,
  defaultDirection,
  filtersOf,
  type Direction,
  type Filters,
  type SortField,
} from './query.ts';

/** The filter builder: Reply, Stars at least, Stars at most and Published. */
export function ReviewsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('reviews.list');
  const fields: ListFilterField[] = [
    {
      id: 'reply',
      label: t('filter.reply'),
      options: REPLY_FILTERS.map((value) => ({ value, label: t(`filter.reply-value.${value}`) })),
    },
    {
      id: 'minRating',
      label: t('filter.min-rating'),
      options: RATINGS.map((value) => ({
        value,
        label: t('filter.stars', { count: Number(value) }),
      })),
    },
    {
      id: 'maxRating',
      label: t('filter.max-rating'),
      options: RATINGS.map((value) => ({
        value,
        label: t('filter.stars', { count: Number(value) }),
      })),
    },
    {
      id: 'within',
      label: t('filter.within'),
      options: PUBLISHED_WITHIN.map((value) => ({
        value,
        label: t('filter.within-value', { days: Number(value) }),
      })),
    },
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

/** The sort menu: one field and the direction, applied as they are chosen. */
export function ReviewsSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: SortField;
  readonly direction: Direction;
  readonly onChange: (sort: SortField, direction: Direction) => void;
}) {
  const t = useTranslations('reviews.list.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORT_FIELDS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={defaultDirection}
      orderLabels={(value) => {
        const kind = value === 'published' ? 'date' : 'rating';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="reviews-sort"
      onChange={(value, next) => onChange(value as SortField, next)}
    />
  );
}

/** The column picker: the stars and the text are always shown, the details can be hidden and moved. */
export function ReviewsColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly ReviewColumn[];
  readonly onSave: (columns: readonly ReviewColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('reviews.list');
  const ts = useTranslations('reviews.list.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={[
        { id: 'rating', label: t('col.rating') },
        { id: 'review', label: t('col.review') },
      ]}
      optionalLabel={(column) => t(`col.${column as ReviewColumn}`)}
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
