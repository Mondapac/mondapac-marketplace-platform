'use client';

import { ListColumnsPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DEFAULT_COLUMNS, OPTIONAL_COLUMNS, type OptionalColumn } from './products-types.ts';

const FIXED = ['image', 'title', 'status', 'category'] as const;

/**
 * The column picker (Figma "Column picker"): the four columns that are always shown, then the
 * optional ones with a check and a move up and down (instead of a drag handle, so a keyboard can
 * reorder). Save keeps the choice for this admin only; Reset puts the defaults back in the form.
 * The picker itself is the shared list picker of `@mondapac/ui`; this gives it the admin's words.
 */
export function ProductsColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('catalog.products.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={FIXED.map((id) => ({ id, label: t(`fixed.${id}`) }))}
      optionalLabel={(column) => t(`optional.${column as OptionalColumn}`)}
      labels={{
        title: t('title'),
        help: t('help'),
        always: t('always'),
        up: (column) => t('up', { column }),
        down: (column) => t('down', { column }),
        reset: t('reset'),
        save: t('save'),
      }}
      onSave={(next) => onSave(next as readonly OptionalColumn[])}
      close={close}
    />
  );
}
