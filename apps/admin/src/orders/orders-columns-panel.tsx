'use client';

import { ListColumnsPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OrderColumn,
} from './orders-columns.ts';

/** The column picker: Order and Status are always shown, the rest can be hidden, shown and moved. */
export function OrdersColumnsPanel({
  columns,
  onSave,
  close,
  without,
}: {
  readonly columns: readonly OrderColumn[];
  /** A column this list never shows (the Customer column on a customer's Orders tab). */
  readonly without?: OrderColumn;
  readonly onSave: (columns: readonly OrderColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('orders');
  const ts = useTranslations('sales-lists.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS.filter((column) => column !== without)}
      defaults={DEFAULT_COLUMNS.filter((column) => column !== without)}
      fixed={(['order', 'status'] as const).map((id) => ({ id, label: t(`col.${id}`) }))}
      optionalLabel={(column) => t(`col.${column as OrderColumn}`)}
      labels={{
        title: ts('title'),
        help: ts('help'),
        always: ts('always'),
        up: (column) => ts('up', { column }),
        down: (column) => ts('down', { column }),
        reset: ts('reset'),
        save: ts('save'),
      }}
      onSave={(next) => onSave(cleanColumns(next).filter((column) => column !== without))}
      close={close}
    />
  );
}
