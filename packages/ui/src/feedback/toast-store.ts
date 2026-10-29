'use client';

import { useSyncExternalStore } from 'react';

/** Panel UX "action notifications": the outcome of what the user just did, shown for a while. */
export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastOptions {
  /** The same id replaces the toast that has it (in place, with its timer restarted). */
  readonly id?: string;
  /** A bold first line. Without it the text itself is the bold line. */
  readonly title?: string;
  /** A smaller line under the text. */
  readonly description?: string;
  readonly action?: ToastAction;
  /** Milliseconds; `Infinity` keeps the toast until it is closed. */
  readonly duration?: number;
}

/** What the screen shows of one toast. */
export interface ToastView {
  readonly id: string;
  readonly type: ToastType;
  readonly text: string;
  readonly title?: string;
  readonly description?: string;
  readonly action?: ToastAction;
  /** Milliseconds the toast lasts; `Infinity` when it stays until closed. */
  readonly duration: number;
  /** True while the timer is held (pointer, focus or a hidden tab). */
  readonly paused: boolean;
  /** Counts the replacements of this id, so the progress bar restarts with the timer. */
  readonly revision: number;
}

export interface ToastSnapshot {
  /** The toasts on screen, oldest first: the newest sits at the bottom. */
  readonly visible: readonly ToastView[];
  /** How many more wait for room. */
  readonly queued: number;
}

export interface ToastPromiseMessages<T> {
  readonly pending: string;
  readonly success: string | ((value: T) => string);
  readonly error: string | ((reason: unknown) => string);
}

/** What holds a toast's timer. */
export type ToastHold = 'pointer' | 'focus';

export const MAX_VISIBLE_TOASTS = 3;

const DURATION: Record<ToastType, number> = {
  success: 5000,
  info: 6000,
  warning: 8000,
  error: Infinity,
  loading: Infinity,
};
const ACTION_DURATION = 10000;

/** An error never leaves on its own; a toast with an action stays long enough to reach it. */
export function toastDuration(type: ToastType, options: ToastOptions = {}): number {
  if (options.duration !== undefined) return options.duration;
  if (type === 'error' || type === 'loading') return Infinity;
  return options.action === undefined ? DURATION[type] : ACTION_DURATION;
}

interface Entry {
  view: Omit<ToastView, 'paused'>;
  holds: Set<ToastHold>;
  /** Milliseconds left when the timer is not running. */
  remaining: number;
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const EMPTY: ToastSnapshot = { visible: [], queued: 0 };

/**
 * The toasts of one screen: at most three visible, the rest queued. Only a visible toast has a
 * running timer; the timer pauses while the pointer or focus is on the toast or the tab is hidden.
 */
export function createToastStore() {
  let entries: Entry[] = [];
  let hidden = false;
  let counter = 0;
  let snapshot: ToastSnapshot = EMPTY;
  const listeners = new Set<() => void>();

  function sync() {
    const now = Date.now();
    entries.forEach((entry, index) => {
      const run =
        index < MAX_VISIBLE_TOASTS &&
        Number.isFinite(entry.view.duration) &&
        entry.holds.size === 0 &&
        !hidden;
      if (run && entry.startedAt === null) {
        entry.startedAt = now;
        const { id } = entry.view;
        entry.timer = setTimeout(() => dismiss(id), entry.remaining);
      } else if (!run && entry.startedAt !== null) {
        clearTimeout(entry.timer);
        entry.remaining = Math.max(0, entry.remaining - (now - entry.startedAt));
        entry.startedAt = null;
      }
    });
    snapshot = {
      visible: entries.slice(0, MAX_VISIBLE_TOASTS).map((entry) => ({
        ...entry.view,
        paused: entry.holds.size > 0 || hidden,
      })),
      queued: Math.max(0, entries.length - MAX_VISIBLE_TOASTS),
    };
    listeners.forEach((listener) => listener());
  }

  function show(type: ToastType, text: string, options: ToastOptions = {}): string {
    const id = options.id ?? `toast-${++counter}`;
    const duration = toastDuration(type, options);
    const existing = entries.find((entry) => entry.view.id === id);
    const view: Omit<ToastView, 'paused'> = {
      id,
      type,
      text,
      duration,
      revision: existing === undefined ? 0 : existing.view.revision + 1,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.action === undefined ? {} : { action: options.action }),
    };
    if (existing === undefined) {
      entries.push({
        view,
        holds: new Set(),
        remaining: duration,
        startedAt: null,
        timer: undefined,
      });
    } else {
      clearTimeout(existing.timer);
      existing.view = view;
      existing.remaining = duration;
      existing.startedAt = null;
    }
    sync();
    return id;
  }

  function dismiss(id?: string) {
    const gone = entries.filter((entry) => id === undefined || entry.view.id === id);
    if (gone.length === 0) return;
    gone.forEach((entry) => clearTimeout(entry.timer));
    entries = entries.filter((entry) => !gone.includes(entry));
    sync();
  }

  function setHold(id: string, hold: ToastHold, on: boolean) {
    const entry = entries.find((candidate) => candidate.view.id === id);
    if (entry === undefined || entry.holds.has(hold) === on) return;
    if (on) entry.holds.add(hold);
    else entry.holds.delete(hold);
    sync();
  }

  function setHidden(value: boolean) {
    if (hidden === value) return;
    hidden = value;
    sync();
  }

  /** A loading toast that turns into the result of the promise. Resolves as the promise does. */
  function promise<T>(
    work: Promise<T>,
    messages: ToastPromiseMessages<T>,
    options: Pick<ToastOptions, 'id'> = {},
  ): Promise<T> {
    const id = show('loading', messages.pending, options);
    work.then(
      (value) =>
        show(
          'success',
          typeof messages.success === 'function' ? messages.success(value) : messages.success,
          { id },
        ),
      (reason: unknown) =>
        show(
          'error',
          typeof messages.error === 'function' ? messages.error(reason) : messages.error,
          { id },
        ),
    );
    return work;
  }

  return {
    show,
    dismiss,
    hold: (id: string, hold: ToastHold) => setHold(id, hold, true),
    release: (id: string, hold: ToastHold) => setHold(id, hold, false),
    setHidden,
    promise,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;

/** The one store of the page; `toast` below is its imperative face. */
export const toastStore = createToastStore();

/**
 * Show the outcome of an action: `toast.success(t('saved'))`. Client code only; mount `<Toaster />`
 * once (the panel shell does). The same `id` replaces a toast instead of stacking another.
 */
export const toast = {
  success: (text: string, options?: ToastOptions) => toastStore.show('success', text, options),
  error: (text: string, options?: ToastOptions) => toastStore.show('error', text, options),
  warning: (text: string, options?: ToastOptions) => toastStore.show('warning', text, options),
  info: (text: string, options?: ToastOptions) => toastStore.show('info', text, options),
  promise: toastStore.promise,
  dismiss: toastStore.dismiss,
};

export function useToasts(store: ToastStore = toastStore): ToastSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY);
}
