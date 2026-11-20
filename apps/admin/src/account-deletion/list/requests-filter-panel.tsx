'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import {
  CANCEL_REASONS,
  DELETES_WITHIN,
  REQUESTERS,
  filtersOf,
  type Filters,
} from './requests-list-types.ts';

/**
 * The filter builder: who asked, why a request was cancelled, when it was requested (a date preset
 * on the clock of the list's zone) and whether it deletes within the next day, week or month.
 */
export function RequestsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('account-deletion.list.filter');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'requestedBy',
      label: t('name.requestedBy'),
      options: REQUESTERS.map((value) => ({ value, label: t(`by.${value}`) })),
    },
    {
      id: 'cancelReason',
      label: t('name.cancelReason'),
      options: CANCEL_REASONS.map((value) => ({ value, label: t(`cancel-reason.${value}`) })),
    },
    {
      id: 'requested',
      label: t('name.requested'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
    {
      id: 'deletes',
      label: t('name.deletes'),
      options: DELETES_WITHIN.map((value) => ({ value, label: t(`deletes.${value}`) })),
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
