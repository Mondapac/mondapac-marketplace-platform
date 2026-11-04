'use client';

import { useId, type InputHTMLAttributes } from 'react';
import { Icon } from '../icon/icon.tsx';

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-label'
> {
  /** The name of the field for readers; the placeholder is the visible hint. */
  readonly label: string;
}

/**
 * Figma Input with a leading search icon: a list's one search box. The label is read by screen
 * readers only (the placeholder and the icon say what it is); the control has the standard height.
 */
export function SearchField({ label, className, ...rest }: SearchFieldProps) {
  const id = useId();
  return (
    <div role="search" className={`relative flex items-center ${className ?? ''}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <span className="pointer-events-none absolute start-3 flex text-icon">
        <Icon name="search" />
      </span>
      <input
        id={id}
        type="search"
        autoComplete="off"
        className="h-(--mp-size-control) w-full rounded-md border border-line-input bg-surface ps-10 pe-3 text-fg"
        {...rest}
      />
    </div>
  );
}
