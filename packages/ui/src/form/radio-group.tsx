'use client';

import { useId, type ReactNode } from 'react';

export interface RadioOption {
  readonly value: string;
  readonly label: string;
  /** Shown under the label and read with it. */
  readonly help?: string;
  readonly disabled?: boolean;
}

export interface RadioGroupProps {
  /** The question the group answers; the fieldset's legend. */
  readonly legend: string;
  readonly name: string;
  /** The chosen value; an empty string when none is chosen. */
  readonly value: string;
  readonly options: readonly RadioOption[];
  readonly onChange: (value: string) => void;
  /** Disables the whole group (a save in flight). */
  readonly disabled?: boolean;
  /** A note under the options, read with the group. */
  readonly note?: ReactNode;
}

/**
 * One choice out of a few, as a fieldset with a legend. Each row is at least 44px high and its
 * whole row is the click target; colours come from tokens only.
 */
export function RadioGroup({
  legend,
  name,
  value,
  options,
  onChange,
  disabled = false,
  note,
}: RadioGroupProps) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <fieldset
      className="flex flex-col gap-1"
      aria-describedby={note === undefined || note === null ? undefined : noteId}
    >
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      {options.map((option, index) => {
        const inputId = `${id}-${index}`;
        const off = disabled || option.disabled === true;
        const helpId = `${inputId}-help`;
        return (
          <div key={option.value} className="flex min-h-(--mp-size-control-sm) items-center gap-3">
            <input
              id={inputId}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={off}
              aria-describedby={option.help === undefined ? undefined : helpId}
              className="size-5 shrink-0 accent-accent disabled:cursor-not-allowed"
              onChange={() => onChange(option.value)}
            />
            <div className="flex flex-col py-2">
              <label
                htmlFor={inputId}
                className={`text-fg ${off ? 'cursor-not-allowed text-fg-muted' : 'cursor-pointer'}`}
              >
                {option.label}
              </label>
              {option.help === undefined ? null : (
                <p id={helpId} className="text-sm text-fg-muted">
                  {option.help}
                </p>
              )}
            </div>
          </div>
        );
      })}
      {note === undefined || note === null ? null : (
        <div id={noteId} className="text-sm text-fg-muted">
          {note}
        </div>
      )}
    </fieldset>
  );
}
