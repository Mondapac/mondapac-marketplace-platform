'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import {
  APPROVAL_REASONS,
  REASONS,
  REQUESTED_BY,
  STATUSES,
  filtersOf,
  type Filters,
} from './credit-requests-list-types.ts';

/**
 * The filter builder: one status inside the view, the reason, why a second admin was needed, who
 * asked (the caller) and when it was requested (a date preset on the clock of the list's zone).
 * The amount range waits for a number field in the panel kit.
 */
export function CreditRequestsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('wallet.list.filter');
  const ts = useTranslations('sales-lists');
  const tw = useTranslations('wallet');
  const fields: ListFilterField[] = [
    {
      id: 'status',
      label: t('name.status'),
      options: STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
    },
    {
      id: 'reason',
      label: t('name.reason'),
      options: REASONS.map((value) => ({ value, label: tw(`credit.reason.${value}`) })),
    },
    {
      id: 'approvalReason',
      label: t('name.approvalReason'),
      options: APPROVAL_REASONS.map((value) => ({
        value,
        label: tw(`result.approval-reason.${value}`),
      })),
    },
    {
      id: 'requestedBy',
      label: t('name.requestedBy'),
      options: REQUESTED_BY.map((value) => ({ value, label: t(`by.${value}`) })),
    },
    {
      id: 'requested',
      label: t('name.requested'),
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
