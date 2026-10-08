'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> {
  readonly label: string;
  /** Help text under the input. */
  readonly help?: ReactNode;
  /** Error text; setting it marks the field invalid. */
  readonly error?: string | undefined;
  /** Password fields get a show/hide toggle; these are its labels. */
  readonly showLabel?: string;
  readonly hideLabel?: string;
}

/** A labelled input with help and error text wired through aria-describedby (WCAG 2.2 AA). */
export function TextField({
  label,
  help,
  error,
  showLabel,
  hideLabel,
  type = 'text',
  className,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password' && showLabel !== undefined && hideLabel !== undefined;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={[
            'h-(--mp-size-control) w-full rounded-md border bg-surface px-3 text-fg',
            error ? 'border-critical-solid' : 'border-line-input',
            isPassword ? 'pe-20' : '',
            className ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-controls={id}
            className="absolute inset-y-0 end-0 px-3 text-sm font-medium text-link"
          >
            {revealed ? hideLabel : showLabel}
          </button>
        ) : null}
      </div>
      {help ? (
        <p id={helpId} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
