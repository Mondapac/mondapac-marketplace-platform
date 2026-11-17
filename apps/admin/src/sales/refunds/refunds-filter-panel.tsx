'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../date-presets.ts';
import {
  ACTORS,
  FILTER_FIELDS,
  LEDGERS,
  LOSS_BEARERS,
  REASONS,
  filtersOf,
  type Filters,
} from './refunds-types.ts';

/**
 * The filter builder: Reason, Requested by, Loss borne by, Seller ledger and Requested, each one
 * select (the dates are presets, worked out on the clock of the list's zone).
 */
export function RefundsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('refunds');
  const ts = useTranslations('sales-lists');
  const to = useTranslations('orders');
  const options = (field: (typeof FILTER_FIELDS)[number]): ListFilterField['options'] => {
    switch (field) {
      case 'reason':
        return REASONS.map((value) => ({ value, label: to(`actions.refund-reason.${value}`) }));
      case 'actor':
        return ACTORS.map((value) => ({ value, label: t(`actor.${value}`) }));
      case 'lossBearer':
        return LOSS_BEARERS.map((value) => ({
          value,
          label: to(`actions.loss-bearer-option.${value}`),
        }));
      case 'ledger':
        return LEDGERS.map((value) => ({ value, label: t(`ledger-filter.${value}`) }));
      case 'requested':
        return DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) }));
    }
  };
  const fields: ListFilterField[] = FILTER_FIELDS.map((field) => ({
    id: field,
    label: t(`filter.name.${field}`),
    options: options(field),
  }));
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
