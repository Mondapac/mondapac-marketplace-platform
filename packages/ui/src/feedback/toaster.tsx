'use client';

import { useEffect, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import { toastStore, useToasts, type ToastType, type ToastView } from './toast-store.ts';

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
 * pointer or focus is on it. Logical properties only, so it mirrors in a right-to-left page.
 */
export function Toaster({ labels, aboveBottomBar = false }: ToasterProps) {
  const { visible } = useToasts();

  useEffect(() => {
    const sync = () => toastStore.setHidden(document.hidden);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
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
      aria-live="polite"
      className={`pointer-events-none fixed inset-x-3 z-30 flex flex-col gap-2 md:inset-x-auto md:end-4 md:w-[min(var(--mp-size-dialog-sm),calc(100%-2rem))] ${aboveBottomBar ? 'bottom-[calc(var(--mp-size-bottom-bar)+0.75rem+env(safe-area-inset-bottom))] md:bottom-4' : 'bottom-4'}`}
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

  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      data-toast={type}
      onPointerEnter={() => toastStore.hold(id, 'pointer')}
      onPointerLeave={() => toastStore.release(id, 'pointer')}
      onFocus={() => toastStore.hold(id, 'focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) toastStore.release(id, 'focus');
      }}
      onKeyDown={onKeyDown}
      className="pointer-events-auto relative grid animate-[mp-toast-in_220ms_ease-out] grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 overflow-hidden rounded-lg border border-line bg-surface p-3 pb-3.5 text-sm text-fg shadow-(--mp-shadow-elevation-floating) [--mp-toast-from:24px] motion-reduce:animate-none rtl:[--mp-toast-from:-24px]"
    >
      {tone === null ? (
        <span
          aria-hidden="true"
          className="size-6 animate-spin rounded-full border-2 border-line border-t-link motion-reduce:animate-none"
        />
      ) : (
        <span className={`flex size-6 items-center justify-center rounded-full ${tone.badge}`}>
          <Icon name={tone.icon} className="size-4" />
        </span>
      )}
      <div className="min-w-0 break-words">
        <p className="font-semibold">{headline}</p>
        {body === null ? null : <p className="text-xs text-fg-secondary">{body}</p>}
        {item.description === undefined ? null : (
          <p className="text-xs text-fg-secondary">{item.description}</p>
        )}
        {item.action === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              toastStore.dismiss(id);
            }}
            className="mt-1.5 text-xs font-semibold text-link underline"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => toastStore.dismiss(id)}
        className="flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-muted hover:text-fg"
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
