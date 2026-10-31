'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../form/button.tsx';
import { EmptyState } from '../form/empty-state.tsx';
import { Icon } from '../icon/icon.tsx';
import { useModal } from '../overlay/dialog.tsx';

/** One change of a settings page as its history shows it; the page words every part. */
export interface SettingsHistoryItem {
  readonly id: string;
  /** "Sara K." / "Mondapac" / "Someone": who, already worded. */
  readonly who: string;
  /** "2 days ago". */
  readonly when: string;
  /** The ISO instant, for `<time>`. */
  readonly dateTime: string;
  /** "Changed: Reason, Status". Field names only, never a value. */
  readonly what: string;
}

export type SettingsHistoryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly items: readonly SettingsHistoryItem[];
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
      /** A "show more" that failed: the rows stay, the button says so. */
      readonly moreFailed: boolean;
    };

export interface SettingsHistoryDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: SettingsHistoryState;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly labels: {
    readonly title: string;
    readonly close: string;
    readonly loading: string;
    readonly emptyTitle: string;
    readonly emptyBody: string;
    readonly error: string;
    readonly retry: string;
    readonly loadMore: string;
    readonly moreFailed: string;
  };
}

const ICON_BUTTON =
  'flex size-(--mp-size-control) shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus';

/**
 * The change history of a settings page (panel settings T3a/T3b): a modal panel from the
 * inline-end edge, built on the native `<dialog>` as the notices drawer is (focus trap, Escape,
 * focus back to the "View history" button), with loading, empty and error states.
 */
export function SettingsHistoryDrawer({
  open,
  onClose,
  state,
  onLoadMore,
  onRetry,
  labels,
}: SettingsHistoryDrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(ref, open);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-density="touch"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-0 ms-auto h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-start text-fg backdrop:bg-scrim backdrop:backdrop-blur-sm motion-reduce:backdrop:backdrop-blur-none sm:w-(--mp-size-sheet) xl:w-(--mp-size-sheet-wide)"
    >
      {open ? (
        <div className="flex h-full flex-col border-line bg-surface shadow-(--mp-shadow-elevation-floating) sm:border-s">
          <div className="flex items-center gap-2 px-4 pt-3 sm:px-6">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-lg font-semibold">
              {labels.title}
            </h2>
            <button
              type="button"
              aria-label={labels.close}
              onClick={onClose}
              className={ICON_BUTTON}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line">
            {state.kind === 'loading' ? (
              <div role="status">
                <span className="sr-only">{labels.loading}</span>
                <ul aria-hidden="true" className="divide-y divide-line-row">
                  {[0, 1, 2, 3].map((row) => (
                    <li
                      key={row}
                      className="flex flex-col gap-2 px-4 py-3 motion-safe:animate-pulse sm:px-6"
                    >
                      <span className="h-3 w-3/5 rounded-sm bg-muted" />
                      <span className="h-3 w-2/5 rounded-sm bg-muted" />
                    </li>
                  ))}
                </ul>
              </div>
            ) : state.kind === 'error' ? (
              <div role="alert" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                <span className="flex size-(--mp-size-control-lg) items-center justify-center rounded-full bg-critical-bg text-critical-fg">
                  <Icon name="alert-circle" />
                </span>
                <p className="max-w-prose text-sm text-fg-muted">{labels.error}</p>
                <Button variant="secondary" onClick={onRetry}>
                  {labels.retry}
                </Button>
              </div>
            ) : state.items.length === 0 ? (
              <EmptyState
                size="compact"
                icon="clock"
                title={labels.emptyTitle}
                body={labels.emptyBody}
              />
            ) : (
              <>
                <ul className="divide-y divide-line-row">
                  {state.items.map((item) => (
                    <li key={item.id} className="flex flex-col gap-1 px-4 py-3 sm:px-6">
                      <span className="break-words text-sm text-fg">
                        <span className="font-medium">{item.who}</span>
                        <span aria-hidden="true"> · </span>
                        <time dateTime={item.dateTime} className="text-fg-muted">
                          {item.when}
                        </time>
                      </span>
                      {item.what === '' ? null : (
                        <span className="break-words text-xs text-fg-muted">{item.what}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {state.hasMore ? (
                  <div className="flex flex-col items-center gap-2 p-4">
                    {state.moreFailed ? (
                      <p role="alert" className="text-sm text-critical-fg">
                        {labels.moreFailed}
                      </p>
                    ) : null}
                    <Button variant="secondary" onClick={onLoadMore} disabled={state.loadingMore}>
                      {labels.loadMore}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** One page of a settings history as the panel's API client answers it; null: it failed. */
export interface HistoryPageData<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/**
 * The state behind {@link SettingsHistoryDrawer}: loads the first page when the drawer opens (and
 * again on every open, so it shows the newest), appends the next page on request, and keeps the
 * rows already shown when a later page fails. `load` returns null when the read failed.
 */
export function useSettingsHistory<T extends { readonly id: string }>(
  load: (after: string | null) => Promise<HistoryPageData<T> | null>,
) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<readonly T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  // A response for a drawer that has closed or reopened since is dropped.
  const generation = useRef(0);

  const first = useCallback(async () => {
    const mine = (generation.current += 1);
    setPhase('loading');
    setMoreFailed(false);
    const page = await load(null);
    if (mine !== generation.current) return;
    if (page === null) {
      setPhase('error');
      return;
    }
    setRows(page.items);
    setNext(page.next);
    setPhase('ready');
  }, [load]);

  useEffect(() => {
    if (open) void first();
    else generation.current += 1;
  }, [open, first]);

  const more = useCallback(async () => {
    if (next === null || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    const page = await load(next);
    if (mine !== generation.current) return;
    setLoadingMore(false);
    if (page === null) {
      setMoreFailed(true);
      return;
    }
    setRows((current) => [...current, ...page.items]);
    setNext(page.next);
  }, [load, next, loadingMore]);

  return {
    open,
    show: useCallback(() => setOpen(true), []),
    close: useCallback(() => setOpen(false), []),
    rows,
    phase,
    hasMore: next !== null,
    loadingMore,
    moreFailed,
    retry: first,
    more,
  };
}
