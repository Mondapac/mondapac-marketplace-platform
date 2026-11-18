'use client';

import { ListColumnsPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  CREDIT_NOTE_COLUMNS,
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OptionalColumn,
} from './invoices-columns.ts';

/**
 * The column picker: Order is always shown, the rest can be hidden, shown and moved. The columns
 * that exist for credit notes only say so in the picker and are skipped on the other tab.
 */
export function InvoicesColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('invoices');
  const ts = useTranslations('sales-lists.columns');
  const label = (column: OptionalColumn) =>
    CREDIT_NOTE_COLUMNS.includes(column)
      ? t('col-credit-only', { column: t(`col.${column}`) })
      : t(`col.${column}`);
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={[{ id: 'order', label: t('col.order') }]}
      optionalLabel={(column) => label(column as OptionalColumn)}
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
