'use client';

import { useId, type InputHTMLAttributes } from 'react';

export interface CheckboxRowProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-describedby'
> {
  readonly label: string;
  readonly help?: string;
}

/** One checkbox with its label (and help) as a single click target. */
export function CheckboxRow({ label, help, ...rest }: CheckboxRowProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        aria-describedby={help ? helpId : undefined}
        className="mt-1 size-4 shrink-0 accent-accent max-lg:mt-4"
        {...rest}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Below 1024 px the label is a full-width target 48 px tall (the panels' phone target
            size); the box is centred on it. */}
        <label
          htmlFor={id}
          className="text-sm font-medium text-fg max-lg:flex max-lg:min-h-12 max-lg:items-center"
        >
          {label}
        </label>
        {help ? (
          <p id={helpId} className="text-sm text-fg-muted">
            {help}
          </p>
        ) : null}
      </div>
    </div>
  );
}
