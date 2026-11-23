'use client';

import { useId } from 'react';

export interface PeriodOption {
  readonly id: string;
  readonly label: string;
}

export interface PeriodSelectorProps {
  /** Names the group ("Period"). */
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  /** What it is compared with and the clock it counts in ("vs previous 30 days · market time (AEDT)"). */
  readonly note?: string;
}

/**
 * The period (or measure) switch of a dashboard ("Today, 7 days, 30 days, This month"): a radio
 * group drawn as segments from the sm width up, so arrow keys move the choice and the checked one
 * is announced; on a phone the same choice is a native select (44 px tall, the system picker).
 */
export function PeriodSelector({ label, options, value, onChange, note }: PeriodSelectorProps) {
  const name = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="sm:hidden">
        <span className="sr-only">{label}</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-measure-select=""
          className="min-h-11 w-full rounded-md border border-line-control bg-surface px-3 text-sm font-medium text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="hidden min-w-0 sm:block">
        <legend className="sr-only">{label}</legend>
        <div className="inline-flex max-w-full flex-wrap rounded-md border border-line-control bg-surface p-0.5">
          {options.map((option) => (
            <label key={option.id} className="relative">
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={option.id === value}
                onChange={() => onChange(option.id)}
                className="peer absolute inset-0 size-full cursor-pointer opacity-0"
              />
              <span className="flex min-h-10 items-center whitespace-nowrap rounded-sm px-3 py-2 text-sm font-medium text-fg-secondary peer-checked:bg-selected peer-checked:font-semibold peer-checked:text-fg peer-checked:shadow-[inset_0_0_0_1px_var(--mp-color-border-control)] peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {note === undefined ? null : <p className="text-xs text-fg-muted">{note}</p>}
    </div>
  );
}
