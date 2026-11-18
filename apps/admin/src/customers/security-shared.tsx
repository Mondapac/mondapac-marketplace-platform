'use client';

import { Badge, Banner, Button, ConfirmAction, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiFailure, ApiResult } from '../api/client.ts';
import { REVEAL_MS, deviceParts } from './security-types.ts';

// What the Account & security sections share (customers management phase 2b, part B): the lazy
// read with its loading, failed and hidden states, the section frame, the reveal rule for the full
// address and IP, and the way a refusal reads.

export type Read<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'hidden' }
  | { readonly state: 'ready'; readonly body: T };

/**
 * One section's read. A 403 hides the section (spec section 8: not an error), anything else shows
 * the error with Retry inside the section and never blocks the rest of the tab. `version` reads
 * again.
 */
export function useRead<T>(
  run: () => Promise<ApiResult<T>>,
  options: {
    readonly enabled?: boolean;
    readonly version?: number;
    readonly onHidden?: () => void;
  },
): { readonly read: Read<T>; readonly retry: () => void } {
  const [read, setRead] = useState<Read<T>>({ state: 'loading' });
  const [tries, setTries] = useState(0);
  const latest = useRef(run);
  latest.current = run;
  const hidden = useRef(options.onHidden);
  hidden.current = options.onHidden;
  const enabled = options.enabled ?? true;
  const version = options.version ?? 0;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setRead({ state: 'loading' });
    void latest.current().then((result) => {
      if (!live) return;
      if (result.ok) {
        setRead({ state: 'ready', body: result.body });
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      if (result.failure.status === 403) {
        setRead({ state: 'hidden' });
        hidden.current?.();
        return;
      }
      setRead({ state: 'failed' });
    });
    return () => {
      live = false;
    };
  }, [enabled, version, tries]);

  return { read, retry: () => setTries((value) => value + 1) };
}

/** The skeleton, the error with Retry, or the ready content of one read. */
export function ReadBody<T>({
  read,
  retry,
  label,
  children,
}: {
  readonly read: Read<T>;
  readonly retry: () => void;
  /** The section's name, for the loading and failed lines. */
  readonly label: string;
  readonly children: (body: T) => ReactNode;
}) {
  const t = useTranslations('customers.security');
  if (read.state === 'loading') {
    return <SkeletonRows label={t('loading', { section: label })} rows={2} />;
  }
  if (read.state === 'failed') {
    return (
      <Banner tone="critical">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{t('failed', { section: label })}</span>
          <Button variant="secondary" onClick={retry}>
            {t('retry')}
          </Button>
        </div>
      </Banner>
    );
  }
  if (read.state === 'hidden') return null;
  return <>{children(read.body)}</>;
}

/** One section of the tab: its own heading (the index's target), key and card. */
export function SectionFrame({
  id,
  title,
  actions,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={`security-${id}`}
      aria-labelledby={`security-${id}-title`}
      data-section={id}
      className="flex scroll-mt-4 flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`security-${id}-title`} tabIndex={-1} className="text-lg font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** "Chrome · Windows", or "Unknown device". */
export function deviceText(code: string | null, t: ReturnType<typeof useTranslations>): string {
  const parts = deviceParts(code);
  if (parts === null) return t('device.unknown');
  return parts.system === '' ? parts.browser : t('device.of', parts);
}

/** The whole minutes of a wait, at least one. */
export function minutesOf(failure: ApiFailure, fallbackSeconds: number): number {
  return Math.max(1, Math.ceil((failure.details?.retryAfterSeconds ?? fallbackSeconds) / 60));
}

/**
 * The words for a refused security action or reveal. A 429 says how long to wait ("Try again in
 * {n} minutes"); the dialog stays open.
 */
export function problemText(
  failure: ApiFailure,
  t: ReturnType<typeof useTranslations>,
  fallbackSeconds = 60,
): string {
  if (failure.status === 429) {
    return t('error.throttled', { minutes: minutesOf(failure, fallbackSeconds) });
  }
  if (failure.status === 403) return t('error.denied');
  if (failure.status === 404) return t('error.gone');
  if (failure.status === 409) return t('error.not-eligible');
  return failure.status === 0 || failure.status >= 500
    ? t('error.unavailable')
    : t('error.unknown');
}

/**
 * Revealed values (full address, full IP) held in memory only: never in a URL, storage, a saved
 * view or an export. Each hides again after five minutes and when the tab unmounts, and `note` is
 * the polite announcement of a hide the admin did not do.
 */
export function useReveals<T>(hiddenNote: string) {
  const [shown, setShown] = useState<ReadonlyMap<string, T>>(new Map());
  const [note, setNote] = useState('');
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const noteRef = useRef(hiddenNote);
  noteRef.current = hiddenNote;

  const hide = useCallback((id: string, announce = false) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setShown((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    if (announce) setNote(noteRef.current);
  }, []);

  const show = useCallback(
    (id: string, value: T) => {
      const timer = timers.current.get(id);
      if (timer !== undefined) clearTimeout(timer);
      setNote('');
      setShown((current) => new Map(current).set(id, value));
      timers.current.set(
        id,
        setTimeout(() => hide(id, true), REVEAL_MS),
      );
    },
    [hide],
  );

  useEffect(() => {
    const held = timers.current;
    return () => {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    };
  }, []);

  return { shown, show, hide, note };
}

/** The polite live region that says a revealed value was hidden again. */
export function RevealNote({ note }: { readonly note: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {note}
    </p>
  );
}

/** The tag every revealed value carries. */
export function RevealedTag() {
  const t = useTranslations('customers.security.reveal');
  return <Badge tone="attention">{t('tag')}</Badge>;
}

/**
 * The level-2 confirmation of a reveal: it says what happens before it happens ("Showing the full
 * address is recorded."), asks the owner, and keeps the dialog open with the reason when refused
 * (a 429 says how long to wait).
 */
export function RevealConfirm<T>({
  target,
  title,
  body,
  confirmLabel,
  run,
  onRevealed,
  onCancel,
}: {
  /** What is being revealed (an id); null closes the dialog. */
  readonly target: string | null;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly run: (target: string) => Promise<ApiResult<T>>;
  readonly onRevealed: (target: string, value: T) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('customers.security');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (target === null) setError(null);
  }, [target]);

  async function confirm() {
    if (target === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await run(target);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onRevealed(target, result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(problemText(result.failure, t));
  }

  return (
    <ConfirmAction
      open={target !== null}
      level={2}
      title={title}
      body={<p>{body}</p>}
      rowName=""
      confirmLabel={confirmLabel}
      cancelLabel={t('cancel')}
      pending={pending}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={() => {
        if (!pending) onCancel();
      }}
    />
  );
}
