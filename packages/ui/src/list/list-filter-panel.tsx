'use client';

import { useState } from 'react';
import { Button } from '../form/button.tsx';
import { IconButton } from '../form/icon-button.tsx';
import { Select, type SelectOption } from '../form/select.tsx';

export interface ListFilterField {
  readonly id: string;
  /** The field's name ("Status"). */
  readonly label: string;
  /** The values it can have; a field with none is left out by the caller. */
  readonly options: readonly SelectOption[];
}

export interface ListFilterLabels {
  readonly title: string;
  readonly matchAll: string;
  readonly field: string;
  readonly fieldPlaceholder: string;
  readonly is: string;
  readonly value: string;
  readonly valuePlaceholder: string;
  readonly remove: string;
  readonly add: string;
  readonly cancel: string;
  readonly apply: string;
}

interface Condition {
  readonly key: number;
  readonly field: string;
  readonly value: string;
}

export interface ListFilterPanelProps {
  readonly fields: readonly ListFilterField[];
  /** The conditions now: a value per field id. */
  readonly values: Readonly<Record<string, string>>;
  readonly labels: ListFilterLabels;
  readonly onApply: (values: Record<string, string>) => void;
  readonly close: () => void;
}

/**
 * The filter builder (Figma "Filter panel") of a list: one row per condition (field, "is",
 * value), Add condition, Cancel and Apply. Every condition must hold. A field is used once, so
 * its row offers the fields no other row has taken; a row with no value yet is dropped on apply.
 */
export function ListFilterPanel({ fields, values, labels, onApply, close }: ListFilterPanelProps) {
  const [rows, setRows] = useState<readonly Condition[]>(() => {
    const start = fields.flatMap((field, index) => {
      const value = values[field.id];
      return value === undefined ? [] : [{ key: index, field: field.id, value }];
    });
    return start.length > 0 ? start : [{ key: 100, field: '', value: '' }];
  });
  const [next, setNext] = useState(200);

  const valueOptions = (field: string): readonly SelectOption[] =>
    fields.find((entry) => entry.id === field)?.options ?? [];
  const change = (key: number, patch: Partial<Condition>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const taken = (key: number) =>
    new Set(rows.filter((row) => row.key !== key && row.field !== '').map((row) => row.field));
  const canAdd = rows.length < fields.length;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const applied: Record<string, string> = {};
        for (const row of rows)
          if (row.field !== '' && row.value !== '') applied[row.field] = row.value;
        onApply(applied);
        close();
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-lg font-semibold text-fg">{labels.title}</h2>
        <p className="text-sm text-fg-muted">{labels.matchAll}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const used = taken(row.key);
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-2 [&_label]:sr-only">
              <div className="min-w-32 basis-full sm:basis-0 sm:flex-1">
                <Select
                  label={labels.field}
                  value={row.field}
                  placeholder={labels.fieldPlaceholder}
                  onChange={(event) => change(row.key, { field: event.target.value, value: '' })}
                  options={fields
                    .filter((field) => !used.has(field.id))
                    .map((field) => ({ value: field.id, label: field.label }))}
                />
              </div>
              <span className="text-sm text-fg-muted">{labels.is}</span>
              <div className="min-w-32 flex-1">
                <Select
                  label={labels.value}
                  value={row.value}
                  placeholder={labels.valuePlaceholder}
                  disabled={row.field === ''}
                  onChange={(event) => change(row.key, { value: event.target.value })}
                  options={valueOptions(row.field)}
                />
              </div>
              <IconButton
                icon="x"
                label={labels.remove}
                disabled={rows.length === 1 && row.field === ''}
                onClick={() =>
                  setRows((current) =>
                    current.length === 1
                      ? [{ key: next, field: '', value: '' }]
                      : current.filter((entry) => entry.key !== row.key),
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      {canAdd ? (
        <div>
          <Button
            variant="link"
            className="min-h-(--mp-size-control-sm)"
            onClick={() => {
              setRows((current) => [...current, { key: next, field: '', value: '' }]);
              setNext((value) => value + 1);
            }}
          >
            {labels.add}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {labels.cancel}
        </Button>
        <Button type="submit">{labels.apply}</Button>
      </div>
    </form>
  );
}
