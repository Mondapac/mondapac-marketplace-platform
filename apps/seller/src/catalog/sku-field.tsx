'use client';

import { Icon } from '@mondapac/ui';
import { useId, type InputHTMLAttributes } from 'react';

/** The look of a checkbox in a table: a stronger edge than the browser's, so it shows in dark. */
export const CHECKBOX =
  'size-4 shrink-0 rounded-sm accent-accent outline outline-1 -outline-offset-1 outline-line-input';

/** An inline field error: a 16 px icon and small text that wraps inside the field's width. */
export function CellError({ id, children }: { readonly id: string; readonly children: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-1 flex items-start gap-1 whitespace-normal text-xs text-critical-fg"
    >
      <span className="mt-px size-4 shrink-0">
        <Icon name="alert-circle" className="size-4" />
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/**
 * A SKU input of the variants table. The label is read by screen readers only; an error marks the
 * input invalid and is linked by `aria-describedby`. The width is the caller's wrapper, so a long
 * message wraps under the input instead of widening the column.
 */
export function SkuField({
  label,
  error,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-invalid' | 'aria-describedby'> & {
  readonly label: string;
  readonly error: string | undefined;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col">
      <input
        id={id}
        type="text"
        aria-label={label}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className={`h-(--mp-size-control) w-full rounded-md border bg-surface px-3 font-mono text-fg placeholder:text-fg-muted ${
          error === undefined ? 'border-line-input' : 'border-critical-solid'
        }`}
        {...rest}
      />
      {error === undefined ? null : <CellError id={errorId}>{error}</CellError>}
    </div>
  );
}
