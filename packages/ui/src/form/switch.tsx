'use client';

import type { ButtonHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'aria-checked' | 'onChange' | 'children'
> {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** Names the switch for assistive technology when no visible label is tied to it. */
  readonly 'aria-label'?: string;
  /** The id of the text that names it (a visible label or heading). */
  readonly 'aria-labelledby'?: string;
}

/**
 * An on/off switch for a setting that takes effect at once (not a form field that is submitted
 * later). A button with `role="switch"`: Space and Enter toggle it. The knob sits at the start
 * edge when off and the end edge when on, so it follows the writing direction.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  type = 'button',
  ...rest
}: SwitchProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={[
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'justify-end bg-accent' : 'justify-start bg-line-control',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <span aria-hidden="true" className="size-5 rounded-full bg-surface shadow-sm" />
    </button>
  );
}
