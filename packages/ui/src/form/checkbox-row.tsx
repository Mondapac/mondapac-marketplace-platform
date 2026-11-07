'use client';

import { useId, type InputHTMLAttributes } from 'react';

export interface CheckboxRowProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-describedby'
> {
  readonly label: string;
  readonly help?: string;
  /**
   * Below 1024 px the label becomes a full-width tap target 48 px tall (14 px of padding around a
   * 20 px line; the box moves down with the first line). The padding is real, so rows never
   * overlap: put touch rows in a list without a gap, where the padding is the spacing.
   */
  readonly touch?: boolean;
}

/**
 * One checkbox with its label. The box and the label are the click target; the help text is
 * linked by aria-describedby and is not part of the target.
 */
export function CheckboxRow({ label, help, touch = false, ...rest }: CheckboxRowProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        aria-describedby={help ? helpId : undefined}
        className={`mt-1 size-4 shrink-0 accent-accent ${touch ? 'max-lg:mt-[18px]' : ''}`}
        {...rest}
      />
      <div className={touch ? 'flex min-w-0 flex-1 flex-col' : 'flex flex-col'}>
        <label
          htmlFor={id}
          className={`text-sm font-medium text-fg ${touch ? 'max-lg:py-3.5' : ''}`}
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
