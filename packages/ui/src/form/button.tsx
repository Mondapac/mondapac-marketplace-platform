import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
  /** Fills the width of its container (auth forms). */
  readonly block?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-hover disabled:bg-accent-disabled disabled:cursor-not-allowed',
  secondary:
    'border border-line-control bg-surface text-fg hover:bg-muted disabled:text-fg-muted disabled:cursor-not-allowed',
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
  ...rest
}: ButtonProps) {
  const size = variant === 'link' ? '' : 'h-(--mp-size-control) px-4';
  return (
    <button
      type={type}
      disabled={disabled || loading}
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
      {...rest}
    >
      {children}
    </button>
  );
}
