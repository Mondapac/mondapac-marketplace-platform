'use client';

import { useState } from 'react';
import { Button } from '../form/button.tsx';
import { CheckboxRow } from '../form/checkbox-row.tsx';
import { IconButton } from '../form/icon-button.tsx';

export interface ListColumnsLabels {
  readonly title: string;
  readonly help: string;
  /** "Always shown", next to each fixed column. */
  readonly always: string;
  readonly up: (column: string) => string;
  readonly down: (column: string) => string;
  readonly reset: string;
  readonly save: string;
}

export interface ListColumnsPanelProps {
  /** The columns shown now, in order (optional columns only). */
  readonly columns: readonly string[];
  /** Every optional column id, in the standard order. */
  readonly optional: readonly string[];
  /** The optional columns shown when nothing is chosen. */
  readonly defaults: readonly string[];
  /** The columns that are always shown, with their names. */
  readonly fixed: readonly { readonly id: string; readonly label: string }[];
  /** The name of an optional column. */
  readonly optionalLabel: (column: string) => string;
  readonly labels: ListColumnsLabels;
  readonly onSave: (columns: readonly string[]) => void;
  readonly close: () => void;
}

/**
 * The column picker (Figma "Column picker") of a list: the columns that are always shown, then
 * the optional ones with a check and a move up and down (instead of a drag handle, so a keyboard
 * can reorder). Save keeps the choice; Reset puts the defaults back in the form.
 */
export function ListColumnsPanel({
  columns,
  optional,
  defaults,
  fixed,
  optionalLabel,
  labels,
  onSave,
  close,
}: ListColumnsPanelProps) {
  const [shown, setShown] = useState<readonly string[]>(columns);
  // The shown columns first, in their order, then the hidden ones in the standard order.
  const all = [...shown, ...optional.filter((column) => !shown.includes(column))];
  const move = (column: string, by: -1 | 1) =>
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
        <h2 className="text-lg font-semibold text-fg">{labels.title}</h2>
        <p className="text-sm text-fg-muted">{labels.help}</p>
      </div>
      <ul className="flex flex-col">
        {fixed.map((column) => (
          <li key={column.id} className="flex min-h-10 items-center justify-between gap-3 text-sm">
            <span className="text-fg-muted">{column.label}</span>
            <span className="text-xs text-fg-muted">{labels.always}</span>
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
                label={optionalLabel(column)}
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
                    label={labels.up(optionalLabel(column))}
                    disabled={at === 0}
                    onClick={() => move(column, -1)}
                  />
                  <IconButton
                    icon="chevron-down"
                    label={labels.down(optionalLabel(column))}
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
          onClick={() => setShown(defaults)}
        >
          {labels.reset}
        </Button>
        <Button type="submit">{labels.save}</Button>
      </div>
    </form>
  );
}
