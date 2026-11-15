import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import { Spinner } from '../loading/spinner.tsx';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  readonly icon: IconName;
  /** What the button does; it is its only text, so always give it. */
  readonly label: string;
  /** Work this button started is running: the spinner replaces the icon, a second click does nothing. */
  readonly loading?: boolean;
}

/** Figma IconButton (Ghost, Md): a square icon-only button; the control size keeps it a touch target. */
export function IconButton({
  icon,
  label,
  className,
  type = 'button',
  loading = false,
  onClick,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      // Loading keeps the button focusable (aria-disabled, not disabled) so focus is not lost.
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      aria-label={label}
      title={label}
      className={`inline-flex size-(--mp-size-control-sm) shrink-0 items-center justify-center rounded-md text-icon enabled:hover:bg-muted disabled:text-icon-muted disabled:cursor-not-allowed ${className ?? ''}`}
      {...rest}
    >
      {loading ? <Spinner /> : <Icon name={icon} />}
    </button>
  );
}
