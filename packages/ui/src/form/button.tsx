import {
  useCallback,
  useLayoutEffect,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type Ref,
} from 'react';
import { Spinner } from '../loading/spinner.tsx';

/**
 * `destructive` is the outlined red button (a row action, Delete in a list); `destructive-solid` is
 * the filled red primary of a confirm dialog for a destructive action (design: Destructive dialog).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'link' | 'destructive' | 'destructive-solid';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /**
   * Work this button started is running (panel loading L1): a 14 px spinner shows before the label
   * at once (no delay), the button keeps its width and focus, and a second click does nothing.
   * The caller disables sibling buttons (Discard) meanwhile.
   */
  readonly loading?: boolean;
  /** The label while loading ("Saving…", "Exporting…"); without it the label stays. */
  readonly loadingLabel?: string;
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
  loadingLabel,
  block = false,
  className,
  disabled,
  children,
  type = 'button',
  onClick,
  ref,
  style,
  ...rest
}: ButtonProps) {
  const size = variant === 'link' ? '' : 'h-(--mp-size-control) px-4';
  const own = useRef<HTMLButtonElement | null>(null);
  // The width at rest, measured after every idle render, so the busy button keeps exactly that
  // width (design: "measured and fixed") and nothing beside it moves when the label changes to the
  // in-progress one ("Save changes" -> "Saving…"); a longer busy label is cut with an ellipsis, so
  // keep it short. A button first rendered busy has no rest width and takes its natural width.
  const restWidth = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!loading && own.current !== null) restWidth.current = own.current.offsetWidth;
  });
  const held = loading && restWidth.current !== null && restWidth.current > 0;
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  return (
    <button
      ref={setRef}
      type={type}
      style={held ? { ...style, width: restWidth.current ?? undefined } : style}
      // Loading keeps the button focusable (aria-disabled, not disabled) so focus is not lost.
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center rounded-md font-medium',
        loading ? 'gap-2' : '',
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
      {loading ? (
        <>
          <Spinner />
          <span className="min-w-0 truncate">{loadingLabel ?? children}</span>
        </>
      ) : (
        children
      )}
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
