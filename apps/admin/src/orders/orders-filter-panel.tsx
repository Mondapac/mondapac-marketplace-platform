'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../sales/date-presets.ts';
import {
  FILTER_FIELDS,
  FULFILMENT_FILTERS,
  PAYMENT_FILTERS,
  filtersOf,
  type Filters,
} from './orders-query.ts';

/**
 * The filter builder: Payment, Fulfilment and Placed (the day the order was placed, as a preset
 * worked out on the clock of the list's zone). The status is the tab, so it is not a field here.
 */
export function OrdersFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('orders');
  const ts = useTranslations('sales-lists');
  const options = (field: (typeof FILTER_FIELDS)[number]): ListFilterField['options'] => {
    switch (field) {
      case 'paymentState':
        return PAYMENT_FILTERS.map((value) => ({ value, label: t(`payment.${value}`) }));
      case 'fulfilment':
        return FULFILMENT_FILTERS.map((value) => ({ value, label: t(`fulfilment.${value}`) }));
      case 'placed':
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
