import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from 'react';

/**
 * `destructive` is the outlined red button (a row action, Delete in a list); `destructive-solid` is
 * the filled red primary of a confirm dialog for a destructive action (design: Destructive dialog).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'link' | 'destructive' | 'destructive-solid';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
  /** Fills the width of its container (auth forms). */
  readonly block?: boolean;
  /** The button element, for a caller that moves focus to it. */
  readonly ref?: Ref<HTMLButtonElement>;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent enabled:hover:bg-accent-hover disabled:bg-muted disabled:text-fg-muted disabled:cursor-not-allowed',
  secondary:
    'border border-line-control bg-surface text-fg hover:bg-muted disabled:text-fg-muted disabled:cursor-not-allowed',
  destructive:
    'border border-critical-border bg-surface text-critical-fg hover:bg-critical-bg disabled:border-line-control disabled:text-fg-muted disabled:cursor-not-allowed',
  'destructive-solid':
    'bg-critical-solid text-on-accent enabled:hover:brightness-90 disabled:bg-muted disabled:text-fg-muted disabled:cursor-not-allowed',
  link: 'text-link underline-offset-2 hover:underline disabled:text-fg-muted disabled:cursor-not-allowed',
};

export function Button({
  variant = 'primary',
  loading = false,
  block = false,
  className,
  disabled,
  children,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  const size = variant === 'link' ? '' : 'h-(--mp-size-control) px-4';
  return (
    <button
      type={type}
      // Loading keeps the button focusable (aria-disabled, not disabled) so focus is not lost.
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center rounded-md font-medium',
        size,
        block ? 'w-full' : '',
        VARIANT[variant],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href: string;
  readonly variant?: Exclude<ButtonVariant, 'link'>;
}

/** A link that looks like a button: a page action that opens another page (New product). */
export function LinkButton({ variant = 'primary', className, children, ...rest }: LinkButtonProps) {
  return (
    <a
      className={[
        'inline-flex h-(--mp-size-control) items-center justify-center rounded-md px-4 font-medium',
        VARIANT[variant],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </a>
  );
}
