'use client';

import { ListColumnsPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OptionalColumn,
} from './queue-columns.ts';

const FIXED = ['seller', 'type', 'kind', 'issuer', 'waiting'] as const;

/** The column picker: the five main columns are always shown, the rest can be shown and moved. */
export function QueueColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('certificates.queue');
  const ts = useTranslations('sales-lists.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={FIXED.map((id) => ({ id, label: t(`col.${id}`) }))}
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
