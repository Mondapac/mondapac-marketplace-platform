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
        className="mt-1 size-4 shrink-0 accent-accent"
        {...rest}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Below 1024 px the label is a full-width tap target at least 48 px tall (the panels'
            phone target size): 14 px of padding above and below a 20 px line, taken back by an
            equal negative margin so nothing moves and the box stays on the first line. */}
        <label htmlFor={id} className="text-sm font-medium text-fg max-lg:-my-3.5 max-lg:py-3.5">
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
