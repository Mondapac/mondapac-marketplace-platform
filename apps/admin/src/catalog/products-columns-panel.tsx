'use client';

import { Button, CheckboxRow, IconButton } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { DEFAULT_COLUMNS, OPTIONAL_COLUMNS, type OptionalColumn } from './products-types.ts';

const FIXED = ['image', 'title', 'status', 'category'] as const;

/** The shown columns first, in their order, then the hidden ones in the standard order. */
const orderOf = (shown: readonly OptionalColumn[]): OptionalColumn[] => [
  ...shown,
  ...OPTIONAL_COLUMNS.filter((column) => !shown.includes(column)),
];

/**
 * The column picker (Figma "Column picker"): the four columns that are always shown, then the
 * optional ones with a check and a move up and down (instead of a drag handle, so a keyboard can
 * reorder). Save keeps the choice for this admin only; Reset puts the defaults back in the form.
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
  const [shown, setShown] = useState<readonly OptionalColumn[]>(columns);
  const all = orderOf(shown);
  const move = (column: OptionalColumn, by: -1 | 1) =>
    setShown((current) => {
      const at = current.indexOf(column);
      const to = at + by;
      if (at < 0 || to < 0 || to >= current.length) return current;
      const copy = [...current];
      copy[at] = current[to]!;
      copy[to] = column;
      return copy;
    });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(shown);
        close();
      }}
    >
      <div>
        <h2 className="text-lg font-semibold text-fg">{t('title')}</h2>
        <p className="text-sm text-fg-muted">{t('help')}</p>
      </div>
      <ul className="flex flex-col">
        {FIXED.map((id) => (
          <li key={id} className="flex min-h-10 items-center justify-between gap-3 text-sm">
            <span className="text-fg-muted">{t(`fixed.${id}`)}</span>
            <span className="text-xs text-fg-muted">{t('always')}</span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col border-t border-line-row pt-2">
        {all.map((column) => {
          const on = shown.includes(column);
          const at = shown.indexOf(column);
          return (
            <li key={column} className="flex min-h-10 items-center justify-between gap-2">
              <CheckboxRow
                label={t(`optional.${column}`)}
                checked={on}
                onChange={(event) =>
                  setShown((current) =>
                    event.target.checked
                      ? [...current, column]
                      : current.filter((entry) => entry !== column),
                  )
                }
              />
              {on ? (
                <span className="flex shrink-0">
                  <IconButton
                    icon="chevron-up"
                    label={t('up', { column: t(`optional.${column}`) })}
                    disabled={at === 0}
                    onClick={() => move(column, -1)}
                  />
                  <IconButton
                    icon="chevron-down"
                    label={t('down', { column: t(`optional.${column}`) })}
                    disabled={at === shown.length - 1}
                    onClick={() => move(column, 1)}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-row pt-3">
        <Button
          variant="link"
          className="min-h-(--mp-size-control-sm)"
          onClick={() => setShown(DEFAULT_COLUMNS)}
        >
          {t('reset')}
        </Button>
        <Button type="submit">{t('save')}</Button>
      </div>
    </form>
  );
}
