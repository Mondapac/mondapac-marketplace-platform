'use client';

import { useState } from 'react';
import { Button } from '../form/button.tsx';
import { CheckboxRow } from '../form/checkbox-row.tsx';
import { IconButton } from '../form/icon-button.tsx';

export interface ColumnPickerLabels {
  readonly title: string;
  readonly help: string;
  /** Shown beside a column that cannot be hidden. */
  readonly always: string;
  readonly up: (column: string) => string;
  readonly down: (column: string) => string;
  readonly reset: string;
  readonly save: string;
}

export interface ColumnPickerPanelProps {
  /** Every optional column, in the standard order. */
  readonly all: readonly string[];
  /** The columns that are always shown, before the optional ones: id and name. */
  readonly fixed: readonly { readonly id: string; readonly label: string }[];
  /** The columns shown now, in their order. */
  readonly shown: readonly string[];
  /** The columns the Reset button puts back. */
  readonly defaults: readonly string[];
  readonly labelOf: (column: string) => string;
  readonly labels: ColumnPickerLabels;
  readonly onSave: (columns: readonly string[]) => void;
  readonly close: () => void;
}

/**
 * The column picker of a list (the content of a Popover): the columns that are always shown, then
 * the optional ones with a check and a move up and down (instead of a drag handle, so a keyboard
 * can reorder). Save keeps the choice; Reset puts the defaults back in the form. A list may show only its
 * fixed columns.
 */
export function ColumnPickerPanel({
  all,
  fixed,
  shown: initial,
  defaults,
  labelOf,
  labels,
  onSave,
  close,
}: ColumnPickerPanelProps) {
  const [shown, setShown] = useState<readonly string[]>(initial);
  // The shown columns first, in their order, then the hidden ones in the standard order.
  const ordered = [...shown, ...all.filter((column) => !shown.includes(column))];
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
        {fixed.map(({ id, label }) => (
          <li key={id} className="flex min-h-10 items-center justify-between gap-3 text-sm">
            <span className="text-fg-muted">{label}</span>
            <span className="text-xs text-fg-muted">{labels.always}</span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col border-t border-line-row pt-2">
        {ordered.map((column) => {
          const on = shown.includes(column);
          const at = shown.indexOf(column);
          return (
            <li key={column} className="flex min-h-10 items-center justify-between gap-2">
              <CheckboxRow
                label={labelOf(column)}
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
                    label={labels.up(labelOf(column))}
                    disabled={at === 0}
                    onClick={() => move(column, -1)}
                  />
                  <IconButton
                    icon="chevron-down"
                    label={labels.down(labelOf(column))}
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
