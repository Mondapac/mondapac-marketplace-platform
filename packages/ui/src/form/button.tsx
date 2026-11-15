import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from 'react';

/**
 * `destructive` is the outlined red button (a row action, Delete in a list); `destructive-solid` is
 * the filled red primary of a confirm dialog for a destructive action (design: Destructive dialog).
 */
export type ButtonVariant =
  'primary' | 'secondary' | 'link' | 'quiet' | 'destructive' | 'destructive-solid';

/** `sm` is the compact control of a toolbar or chip row (height of `--mp-size-control-sm`, text-sm). */
export type ButtonSize = 'default' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
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
  /** A neutral text button (Clear all): grey text, a muted background on hover. */
  quiet:
    'text-fg-secondary hover:bg-muted hover:text-fg disabled:text-fg-muted disabled:cursor-not-allowed',
  link: 'text-link underline-offset-2 hover:underline disabled:text-fg-muted disabled:cursor-not-allowed',
};

export function Button({
  variant = 'primary',
  size = 'default',
  loading = false,
  block = false,
  className,
  disabled,
  children,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  const sizeClass =
    size === 'sm'
      ? variant === 'link'
        ? 'min-h-(--mp-size-control-sm) text-sm'
        : 'h-(--mp-size-control-sm) px-3 text-sm'
      : variant === 'link'
        ? ''
        : 'h-(--mp-size-control) px-4';
  return (
    <button
      type={type}
      // Loading keeps the button focusable (aria-disabled, not disabled) so focus is not lost.
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium',
        sizeClass,
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
  readonly variant?: Exclude<ButtonVariant, 'link' | 'quiet'>;
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
