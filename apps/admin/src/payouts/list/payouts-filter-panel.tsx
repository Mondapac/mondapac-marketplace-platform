'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { APPROVAL_MODES, filtersOf, type Filters } from './payouts-list-types.ts';

/**
 * The filter builder: Approval (automatic or by an admin) and Created (a date preset, worked out
 * on the clock of the list's zone). The stage is a view, so it is not a filter.
 */
export function PayoutsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('payouts.list');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'approvalMode',
      label: t('filter.name.approvalMode'),
      options: APPROVAL_MODES.map((value) => ({ value, label: t(`filter.mode.${value}`) })),
    },
    {
      id: 'created',
      label: t('filter.name.created'),
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
