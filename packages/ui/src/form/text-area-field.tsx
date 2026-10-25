'use client';

import { useId, type ReactNode, type TextareaHTMLAttributes } from 'react';

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> {
  readonly label: string;
  /** Help text under the text area. */
  readonly help?: ReactNode;
  /** Error text; setting it marks the field invalid. */
  readonly error?: string | undefined;
  /** A line under the control that counts characters ("120 / 2000"); part of the description. */
  readonly counter?: ReactNode;
  /** Marks the label "(optional)"; the text is the Market-neutral word from the caller. */
  readonly optionalLabel?: string;
}

/** A labelled multi-line text field with help, counter and error text wired through aria-describedby. */
export function TextAreaField({
  label,
  help,
  error,
  counter,
  optionalLabel,
  rows = 6,
  className,
  ...rest
}: TextAreaFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const counterId = `${id}-counter`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, counter ? counterId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {optionalLabel ? (
          <span className="font-normal text-fg-muted"> ({optionalLabel})</span>
        ) : null}
      </label>
      <textarea
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={[
          'w-full rounded-md border bg-surface px-3 py-2 text-fg read-only:bg-subtle',
          error ? 'border-critical-solid' : 'border-line-input',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
      {help ? (
        <p id={helpId} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
      {counter ? (
        <div id={counterId} className="text-sm text-fg-muted">
          {counter}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
