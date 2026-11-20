'use client';

import {
  ListColumnsPanel,
  ListFilterPanel,
  ListSortPanel,
  type ListFilterField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { SEVERITIES } from '../types.ts';
import {
  DEFAULT_COLUMNS,
  FIXED_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OptionalColumn,
} from './list-columns.ts';
import {
  KEY_TYPES,
  MIN_EVENTS_CHOICES,
  RULE_CODES,
  SORTS,
  defaultDirection,
  filtersOf,
  type Direction,
  type Filters,
  type Sort,
} from './list-types.ts';

const NS = 'security-centre.list';

/**
 * The filter builder: Severity, Rule, Key type, Opened (a date preset, worked out on the clock of
 * the list's zone) and Events at least. The state is a view, so it is not a filter; the key
 * itself is the search box.
 */
export function AlertFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations(NS);
  const tc = useTranslations('security-centre');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'severity',
      label: t('filter.name.severity'),
      options: SEVERITIES.map((value) => ({ value, label: tc(`severity.${value}`) })),
    },
    {
      id: 'rule',
      label: t('filter.name.rule'),
      options: RULE_CODES.map((value) => ({ value, label: t(`rule.${value}`) })),
    },
    {
      id: 'keyType',
      label: t('filter.name.keyType'),
      options: KEY_TYPES.map((value) => ({ value, label: tc(`key.${value}`) })),
    },
    {
      id: 'opened',
      label: t('filter.name.opened'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
    {
      id: 'minEvents',
      label: t('filter.name.minEvents'),
      options: MIN_EVENTS_CHOICES.map((value) => ({
        value,
        label: t('filter.events', { count: Number(value) }),
      })),
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

/** The sort menu: one field and the direction, applied as they are chosen. */
export function AlertSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations(`${NS}.sort`);
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as Sort)}
      orderLabels={(value) => [t(`${value as Sort}.first`), t(`${value as Sort}.second`)]}
      labels={{ by: t('by'), order: t('order') }}
      name="security-alert-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}

/** The column picker: the seven main columns are always shown, the rest can be shown and moved. */
export function AlertColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations(NS);
  const ts = useTranslations('sales-lists.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={FIXED_COLUMNS.map((id) => ({ id, label: t(`col.${id}`) }))}
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
