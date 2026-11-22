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
 * The period switch of a dashboard ("Today, 7 days, 30 days, This month"): a radio group drawn as
 * segments, so arrow keys move the choice and the checked one is announced.
 */
export function PeriodSelector({ label, options, value, onChange, note }: PeriodSelectorProps) {
  const name = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <fieldset className="min-w-0">
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
              <span className="block whitespace-nowrap rounded-sm px-3 py-2 text-sm font-medium text-fg-secondary peer-checked:bg-selected peer-checked:font-semibold peer-checked:text-fg peer-checked:shadow-[inset_0_0_0_1px_var(--mp-color-border-control)] peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
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
