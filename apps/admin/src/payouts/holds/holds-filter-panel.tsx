'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { HOLD_REASONS } from '../seller-types.ts';
import { ORIGINS, SCOPES, STATUSES, filtersOf, type Filters } from './holds-list-types.ts';

/**
 * The filter builder: active or released, the reason, who placed it, whether it covers the whole
 * seller or one seller order, and when it was placed (a date preset on the clock of the list's
 * zone).
 */
export function HoldsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('payouts.seller.holds.list.filter');
  const tr = useTranslations('payouts.seller.holds.reason');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'status',
      label: t('name.status'),
      options: STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
    },
    {
      id: 'reason',
      label: t('name.reason'),
      options: HOLD_REASONS.map((value) => ({ value, label: tr(value) })),
    },
    {
      id: 'origin',
      label: t('name.origin'),
      options: ORIGINS.map((value) => ({ value, label: t(`origin.${value}`) })),
    },
    {
      id: 'scope',
      label: t('name.scope'),
      options: SCOPES.map((value) => ({ value, label: t(`scope.${value}`) })),
    },
    {
      id: 'placed',
      label: t('name.placed'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
  ];
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
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
      onApply={(values) => onApply(filtersOf(values))}
      close={close}
    />
  );
}
