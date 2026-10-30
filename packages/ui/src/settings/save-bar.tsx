'use client';

import { useLayoutEffect, useRef } from 'react';
import { Button } from '../form/button.tsx';

/** The CSS variable the bar sets on the document while it shows; the Toaster reads it. */
export const SAVE_BAR_OFFSET_VAR = '--mp-savebar-offset';

export interface SaveBarProps {
  /** How many fields differ from the saved values; the bar shows from 1. */
  readonly count: number;
  /** "2 unsaved changes": the caller formats the count in its language. */
  readonly summary: string;
  /** How many fields need fixing; Save is disabled above 0. */
  readonly errorCount?: number;
  /** "1 needs fixing": shown after the summary when `errorCount` is above 0. */
  readonly errorsSummary?: string;
  /**
   * A page that is unsaved by definition (a new record) passes this: the bar then shows at
   * `count` 0 with this text ("New role · nothing entered yet") instead of an invented change.
   */
  readonly emptySummary?: string;
  readonly saving?: boolean;
  readonly labels: {
    /** Name of the bar's landmark. */
    readonly region: string;
    readonly discard: string;
    readonly save: string;
    readonly saving: string;
  };
  readonly onDiscard: () => void;
  /** Seller only: the phone bottom bar shows, so the bar sits above it. */
  readonly aboveBottomBar?: boolean;
}

/**
 * The one save bar of a settings page: sticky at the bottom of the content, with the count of
 * unsaved changes, Discard and Save changes. Save is a submit button, so the bar belongs inside
 * the page's form. While it shows it keeps `--mp-savebar-offset` on the document (the distance from the
 * screen bottom to the bar's top, 0 when the bar is below the fold), so toasts stack above it
 * instead of covering Save.
 */
export function SaveBar({
  count,
  summary,
  errorCount = 0,
  errorsSummary,
  emptySummary,
  saving = false,
  labels,
  onDiscard,
  aboveBottomBar = false,
}: SaveBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = count > 0 || emptySummary !== undefined;

  useLayoutEffect(() => {
    const bar = ref.current;
    if (!visible || bar === null) return;
    const root = document.documentElement;
    // How far the bar's top edge is above the bottom of the screen: the bar is sticky, so on a
    // long page it sits at the bottom, but on a short page it sits in the flow, higher up. Below
    // the fold it is 0 and toasts keep their own place.
    const apply = () => {
      const above = root.clientHeight - bar.getBoundingClientRect().top;
      root.style.setProperty(SAVE_BAR_OFFSET_VAR, `${Math.max(0, Math.round(above))}px`);
    };
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(bar);
    observer?.observe(root);
    window.addEventListener('scroll', apply, { passive: true });
    window.addEventListener('resize', apply, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      root.style.removeProperty(SAVE_BAR_OFFSET_VAR);
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div
      ref={ref}
      role="region"
      aria-label={labels.region}
      className={`sticky z-10 flex flex-wrap items-center gap-3 rounded-lg border border-line-control bg-surface px-4 py-3 shadow-(--mp-shadow-elevation-floating) ${aboveBottomBar ? 'bottom-[calc(var(--mp-size-bottom-bar)+0.75rem+env(safe-area-inset-bottom))] md:bottom-3' : 'bottom-3'}`}
    >
      <p
        role="status"
        className="flex min-w-0 basis-full items-center gap-2 text-sm text-fg sm:flex-1 sm:basis-0"
      >
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention-solid" />
        <span className="min-w-0 break-words">
          {count > 0 ? summary : emptySummary}
          {errorCount > 0 && errorsSummary ? (
            <span className="text-critical-fg"> · {errorsSummary}</span>
          ) : null}
        </span>
      </p>
      <div className="ms-auto flex shrink-0 items-center gap-3">
        <Button variant="secondary" disabled={saving} onClick={onDiscard}>
          {labels.discard}
        </Button>
        <Button type="submit" disabled={errorCount > 0} loading={saving}>
          {saving ? labels.saving : labels.save}
        </Button>
      </div>
    </div>
  );
}
