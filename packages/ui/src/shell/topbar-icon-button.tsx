'use client';

import { forwardRef, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * The look of every round icon control on the right of the top bar (john 2026-11-23, option A):
 * 40 px on tablets and up, 44 px on phones; grey fill on hover, soft accent fill while pressed
 * or open, a 2 px focus ring.
 */
export const TOPBAR_ICON_CLASS =
  'relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-icon transition-colors hover:bg-muted hover:text-fg focus-visible:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:size-10';

/** The filled look of a pressed or open button. A toggle that shows its state another way (the pin star) opts out. */
const PRESSED_CLASS =
  'aria-pressed:bg-selected aria-pressed:text-fg aria-expanded:bg-selected aria-expanded:text-fg';

export interface TopbarIconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children' | 'title'
> {
  /** The accessible name, and the tooltip text. */
  readonly label: string;
  /** Shown after the label in the tooltip, such as the keys of a shortcut. */
  readonly hint?: ReactNode;
  /** The icon. */
  readonly children: ReactNode;
  /** A badge on the top right corner; the button's name must carry its meaning. */
  readonly badge?: ReactNode;
  /** False when the pressed state is shown by the icon itself, so no pressed fill is added. */
  readonly pressedFill?: boolean;
  /** Extra classes for the button, such as a colour for the pinned state. */
  readonly className?: string;
}

/**
 * A round, icon-only button with a tooltip. The tooltip shows on hover and keyboard focus, is
 * linked with `aria-describedby`, and Escape hides it without moving focus.
 */
export const TopbarIconButton = forwardRef<HTMLButtonElement, TopbarIconButtonProps>(
  function TopbarIconButton(
    {
      label,
      hint,
      children,
      badge,
      pressedFill = true,
      className = '',
      onKeyDown,
      onPointerLeave,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const tipId = useId();
    const [dismissed, setDismissed] = useState(false);
    return (
      <span className="group/tip relative inline-flex">
        <button
          {...rest}
          ref={ref}
          type="button"
          aria-label={label}
          aria-describedby={tipId}
          className={`${TOPBAR_ICON_CLASS} ${pressedFill ? PRESSED_CLASS : ''} ${className}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDismissed(true);
            onKeyDown?.(event);
          }}
          onPointerLeave={(event) => {
            setDismissed(false);
            onPointerLeave?.(event);
          }}
          onBlur={(event) => {
            setDismissed(false);
            onBlur?.(event);
          }}
        >
          {children}
          {badge}
        </button>
        <span
          id={tipId}
          role="tooltip"
          data-dismissed={dismissed}
          className="pointer-events-none absolute end-0 top-full z-50 mt-2 hidden items-center gap-2 whitespace-nowrap rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium text-surface shadow-lg group-hover/tip:data-[dismissed=false]:flex group-focus-within/tip:data-[dismissed=false]:flex max-md:!hidden"
        >
          {label}
          {hint}
        </span>
      </span>
    );
  },
);
