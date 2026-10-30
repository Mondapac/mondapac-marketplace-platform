'use client';

import { useEffect, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import {
  TOAST_EXIT_MS,
  consumeFlash,
  toastStore,
  useToasts,
  type ToastType,
  type ToastView,
} from './toast-store.ts';

export interface ToasterProps {
  readonly labels: {
    /** Name of the notifications region. */
    readonly region: string;
    readonly close: string;
  };
  /** The seller phone bottom bar is showing: the stack sits above it. */
  readonly aboveBottomBar?: boolean;
}

const TONE: Record<
  Exclude<ToastType, 'loading'>,
  { icon: IconName; badge: string; bar: string }
> = {
  success: { icon: 'check', badge: 'bg-success-bg text-success-fg', bar: 'bg-success-fg' },
  error: { icon: 'alert-circle', badge: 'bg-critical-bg text-critical-fg', bar: 'bg-critical-fg' },
  warning: {
    icon: 'alert-triangle',
    badge: 'bg-attention-bg text-attention-fg',
    bar: 'bg-attention-fg',
  },
  info: { icon: 'info', badge: 'bg-info-bg text-info-fg', bar: 'bg-info-fg' },
};

/**
 * The one stack of action notifications, mounted once in the panel shell. It sits at the bottom,
 * on the inline-end corner (full width on phones), never takes focus, and keeps a toast while the
 * pointer or focus is on it. While a settings `SaveBar` shows it sets `--mp-savebar-offset`, and
 * the stack rises above the bar. Logical properties only, so it mirrors in a right-to-left page.
 */
export function Toaster({ labels, aboveBottomBar = false }: ToasterProps) {
  const { visible } = useToasts();

  // The outcome of an action that navigated here (`toast.flash`), shown once.
  useEffect(() => {
    consumeFlash();
  }, []);

  useEffect(() => {
    const sync = () => toastStore.setHidden(document.hidden);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  useEffect(() => {
    // A closed toast leaves with a short exit animation, none under reduced motion.
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => toastStore.setExitMs(query.matches ? 0 : TOAST_EXIT_MS);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  return <ToastStack items={visible} labels={labels} aboveBottomBar={aboveBottomBar} />;
}

/** The stack itself, for a given list: what `Toaster` renders from the store. */
export function ToastStack({
  items,
  labels,
  aboveBottomBar = false,
}: ToasterProps & { readonly items: readonly ToastView[] }) {
  return (
    <div
      role="region"
      aria-label={labels.region}
      className={`pointer-events-none fixed inset-x-3 z-30 flex flex-col gap-2 md:inset-x-auto md:end-4 md:w-[min(var(--mp-size-dialog-sm),calc(100%-2rem))] ${aboveBottomBar ? 'bottom-[max(calc(var(--mp-size-bottom-bar)+0.75rem+env(safe-area-inset-bottom)),calc(var(--mp-savebar-offset,0px)+0.75rem))] md:bottom-[max(1rem,calc(var(--mp-savebar-offset,0px)+1rem))]' : 'bottom-[max(1rem,calc(var(--mp-savebar-offset,0px)+1rem))]'}`}
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} closeLabel={labels.close} />
      ))}
    </div>
  );
}

function ToastCard({
  item,
  closeLabel,
}: {
  readonly item: ToastView;
  readonly closeLabel: string;
}) {
  const { id, type, paused } = item;
  const tone = type === 'loading' ? null : TONE[type];
  const headline = item.title ?? item.text;
  const body = item.title === undefined ? null : item.text;

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') toastStore.dismiss(id);
  }

  // One pattern: the region only names the landmark; each toast announces itself (an error at
  // once, the others politely). The loading card stays silent: only its result is announced.
  const announce =
    type === 'loading'
      ? ({ 'aria-live': 'off' } as const)
      : ({ role: type === 'error' ? 'alert' : 'status' } as const);

  return (
    <div
      {...announce}
      data-toast={type}
      data-exiting={item.exiting ? '' : undefined}
      onPointerEnter={() => toastStore.hold(id, 'pointer')}
      onPointerLeave={() => toastStore.release(id, 'pointer')}
      onFocus={() => toastStore.hold(id, 'focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) toastStore.release(id, 'focus');
      }}
      onKeyDown={onKeyDown}
      className="pointer-events-auto relative grid animate-[mp-toast-in_var(--mp-motion-duration-slow)_var(--mp-motion-easing)] grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-(--mp-space-2-5) overflow-hidden rounded-lg border border-line-control bg-surface p-3 pb-3.5 text-sm text-fg shadow-(--mp-shadow-elevation-floating) [--mp-toast-from:24px] data-exiting:animate-[mp-toast-out_var(--mp-motion-duration-base)_ease-in_forwards] motion-reduce:animate-none motion-reduce:data-exiting:animate-none rtl:[--mp-toast-from:-24px]"
    >
      {tone === null ? (
        <>
          <span
            aria-hidden="true"
            className="size-(--mp-size-badge) animate-spin rounded-full border-2 border-line border-t-link motion-reduce:hidden"
          />
          {/* Under reduced motion a still icon stands in for the spinning ring. */}
          <span
            aria-hidden="true"
            className="hidden size-(--mp-size-badge) items-center justify-center rounded-full bg-info-bg text-info-fg motion-reduce:flex"
          >
            <Icon name="clock" className="size-4" />
          </span>
        </>
      ) : (
        <span
          className={`flex size-(--mp-size-badge) items-center justify-center rounded-full ${tone.badge}`}
        >
          <Icon name={tone.icon} className="size-4" />
        </span>
      )}
      {/* The text starts level with the badge: half the badge's excess over one 20 px line. */}
      <div className="min-w-0 break-words pt-[calc((var(--mp-size-badge)-1.25rem)/2)]">
        <p className="font-semibold">{headline}</p>
        {body === null ? null : <p className="text-xs text-fg-secondary">{body}</p>}
        {item.description === undefined ? null : (
          <p className="text-xs text-fg-secondary">{item.description}</p>
        )}
        {item.action === undefined ? null : (
          <div className="mt-1.5">
            {/* A phone touch target, with a negative margin so the card keeps its height. */}
            <button
              type="button"
              onClick={() => {
                item.action?.onClick();
                toastStore.dismiss(id);
              }}
              className="inline-flex items-center text-xs font-semibold text-link underline max-md:-my-[calc((var(--mp-size-control-sm)-1rem)/2)] max-md:min-h-(--mp-size-control-sm)"
            >
              {item.action.label}
            </button>
          </div>
        )}
      </div>
      {/* Centred on the badge line; the negative margins give back the height the target adds. */}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => toastStore.dismiss(id)}
        className="-my-[calc((var(--mp-size-control-sm)-var(--mp-size-badge))/2)] -me-1 flex size-(--mp-size-control-sm) items-center justify-center rounded-md text-fg-muted hover:bg-muted hover:text-fg"
      >
        <Icon name="x" />
      </button>
      {tone === null || !Number.isFinite(item.duration) ? null : (
        <span
          key={item.revision}
          aria-hidden="true"
          data-toast-bar=""
          style={{
            animationDuration: `${item.duration}ms`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
          className={`absolute inset-x-0 bottom-0 h-[3px] origin-left animate-[mp-toast-shrink_linear_forwards] rtl:origin-right ${tone.bar}`}
        />
      )}
    </div>
  );
}
