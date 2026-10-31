'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icon/icon.tsx';
import { useModal } from '../overlay/dialog.tsx';
import { isListKey, moveActive } from './palette-nav.ts';
import { searchPalette, type PaletteEntry, type PaletteKind } from './palette-index.ts';

export interface CommandPaletteLabels {
  /** Name of the dialog and of the search field. */
  readonly title: string;
  readonly placeholder: string;
  readonly close: string;
  /** Name of the results list. */
  readonly results: string;
  /** Section headings. */
  readonly pinned: string;
  readonly recent: string;
  readonly kind: Readonly<Record<PaletteKind, string>>;
  /** "No results for “{query}”"; `{query}` is replaced. */
  readonly empty: string;
  /** The second line of the no-results state. */
  readonly emptyHint: string;
  /** Live announcement: "1 result" and "{count} results". */
  readonly countOne: string;
  readonly countMany: string;
  /** Footer hints, shown from tablets up where a keyboard is likely. */
  readonly hintMove: string;
  readonly hintOpen: string;
  readonly hintClose: string;
  /** After the "?" key: "for shortcuts". */
  readonly hintShortcuts: string;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly entries: readonly PaletteEntry[];
  /** The pinned pages, in pin order; shown first while the field is empty. */
  readonly pinned?: readonly PaletteEntry[];
  /** The recently visited pages, newest first; shown while the field is empty. */
  readonly recent: readonly PaletteEntry[];
  readonly labels: CommandPaletteLabels;
  /** Called when an entry is chosen. Returning true means it was handled: the browser does not go there. */
  readonly onChoose: (entry: PaletteEntry) => boolean | void;
  /** Goes to a path; the browser's own navigation unless a caller (a test) replaces it. */
  readonly navigate?: (href: string) => void;
}

interface Section {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly PaletteEntry[];
}

/** What typing finds, in this order. Actions are only offered before typing. */
const KIND_ORDER: readonly PaletteKind[] = ['setting', 'page'];

/**
 * The ⌘K palette: a modal dialog holding a combobox (the search field) and a listbox (the
 * results), after the WAI-ARIA combobox pattern. Focus stays in the field; the arrow keys move the
 * active option (`aria-activedescendant`), Enter opens it, Escape closes. With an empty field it
 * lists the pinned pages, the recent pages and the actions; typing lists settings, then pages, with
 * the count shown under the field and announced.
 */
export function CommandPalette({
  open,
  onClose,
  entries,
  pinned = [],
  recent,
  labels,
  onChoose,
  navigate = (href) => window.location.assign(href),
}: CommandPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const base = useId();
  useModal(dialog, open, field);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const sections = useMemo<readonly Section[]>(() => {
    if (query.trim() === '') {
      const actions = entries.filter((entry) => entry.kind === 'action');
      const pinnedIds = new Set(pinned.map((entry) => entry.id));
      return [
        { id: 'pinned', heading: labels.pinned, items: pinned },
        {
          id: 'recent',
          heading: labels.recent,
          items: recent.filter((entry) => !pinnedIds.has(entry.id)),
        },
        { id: 'action', heading: labels.kind.action, items: actions },
      ].filter((section) => section.items.length > 0);
    }
    const hits = searchPalette(entries, query);
    return KIND_ORDER.map((kind) => ({
      id: kind,
      heading: labels.kind[kind],
      items: hits.filter((hit) => hit.kind === kind),
    })).filter((section) => section.items.length > 0);
  }, [entries, pinned, recent, query, labels]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const optionId = (index: number) => `${base}-option-${index}`;
  const current = active >= 0 && active < flat.length ? active : -1;

  useEffect(() => {
    if (current >= 0) {
      document.getElementById(optionId(current))?.scrollIntoView?.({ block: 'nearest' });
    }
    // optionId only depends on `base`.
  }, [current, flat]);

  // The phone's on-screen keyboard shrinks the visual viewport, not the layout one: the sheet is
  // sized from it so the results stay above the keyboard.
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || viewport === null || viewport === undefined) return;
    const measure = () => setVisibleHeight(viewport.height);
    measure();
    viewport.addEventListener('resize', measure);
    return () => viewport.removeEventListener('resize', measure);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Home and End stay with the text field (they move its caret), as in the APG combobox.
    if (isListKey(event.key) && event.key !== 'Home' && event.key !== 'End') {
      event.preventDefault();
      setActive(moveActive(current, flat.length, event.key));
    } else if (event.key === 'Enter') {
      const entry = flat[current];
      if (entry === undefined) return;
      event.preventDefault();
      const handled = onChoose(entry) === true;
      onClose();
      if (!handled) navigate(entry.href);
    }
  }

  const searching = query.trim() !== '';
  const announcement = !open
    ? ''
    : flat.length === 0
      ? searching
        ? labels.empty.replace('{query}', query.trim())
        : ''
      : flat.length === 1
        ? labels.countOne
        : labels.countMany.replace('{count}', String(flat.length));

  let index = -1;
  return (
    <dialog
      ref={dialog}
      aria-label={labels.title}
      data-density="touch"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Only the backdrop targets the dialog element itself; the panel inside fills it.
        if (event.target === dialog.current) onClose();
      }}
      // A sheet from the top edge on phones (the scrim shows below it), a centred panel from
      // 640 px. Its height follows the visual viewport, so the keyboard never covers the results.
      style={{
        maxHeight: `min(${visibleHeight === null ? '100dvh' : `${visibleHeight}px`}, 34rem)`,
      }}
      className="m-0 mb-auto h-fit w-full max-w-none overflow-hidden rounded-b-lg border-0 bg-surface p-0 pt-[env(safe-area-inset-top)] text-start text-fg backdrop:bg-fg/40 sm:mx-auto sm:mt-[10vh] sm:w-[min(40rem,calc(100%-2rem))] sm:rounded-lg sm:border sm:border-line sm:pt-0"
    >
      {open ? (
        <div className="flex max-h-[inherit] flex-col">
          <div className="flex shrink-0 items-center border-b border-line focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-focus">
            <span className="ps-4 text-icon">
              <Icon name="search" />
            </span>
            <input
              ref={field}
              type="text"
              role="combobox"
              aria-label={labels.title}
              aria-haspopup="listbox"
              aria-expanded={flat.length > 0}
              aria-controls={flat.length > 0 ? `${base}-list` : undefined}
              aria-autocomplete="list"
              aria-activedescendant={current >= 0 ? optionId(current) : undefined}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={labels.placeholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              // The ring is drawn once, on the whole bar (focus-within), not on the field.
              style={{ outline: 'none' }}
              className="h-14 min-w-0 flex-1 bg-transparent px-3 text-base text-fg placeholder:text-fg-muted"
            />
            <button
              type="button"
              aria-label={labels.close}
              onClick={onClose}
              className="flex min-h-12 min-w-12 items-center justify-center text-fg-secondary hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <Icon name="x" />
            </button>
          </div>
          {searching && flat.length > 0 ? (
            // Seen, not read twice: the live region below announces it.
            <p aria-hidden="true" className="shrink-0 px-4 pt-2 text-xs text-fg-muted">
              {flat.length === 1
                ? labels.countOne
                : labels.countMany.replace('{count}', String(flat.length))}
            </p>
          ) : null}
          <div
            id={flat.length > 0 ? `${base}-list` : undefined}
            role={flat.length > 0 ? 'listbox' : undefined}
            aria-label={flat.length > 0 ? labels.results : undefined}
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {sections.map((section) => (
              <div
                key={section.id}
                role="group"
                aria-labelledby={`${base}-heading-${section.id}`}
                className="pb-2 last:pb-0"
              >
                <p
                  id={`${base}-heading-${section.id}`}
                  className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
                >
                  {section.heading}
                </p>
                {section.items.map((entry) => {
                  index += 1;
                  const mine = index;
                  return (
                    <a
                      key={entry.id}
                      id={optionId(mine)}
                      role="option"
                      aria-selected={mine === current}
                      href={entry.href}
                      tabIndex={-1}
                      onClick={(event) => {
                        const handled = onChoose(entry) === true;
                        if (handled) event.preventDefault();
                        onClose();
                      }}
                      onMouseMove={() => {
                        if (mine !== current) setActive(mine);
                      }}
                      className={`flex min-h-12 items-center gap-3 rounded-md px-3 py-2 text-fg ${mine === current ? 'bg-selected outline-2 -outline-offset-2 outline-focus' : ''}`}
                    >
                      <Icon name={entry.icon} className="text-icon" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="break-words">{entry.label}</span>
                        {entry.context === undefined ? null : (
                          <span className="break-words text-xs text-fg-muted">{entry.context}</span>
                        )}
                      </span>
                    </a>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && searching ? (
              <div className="px-3 py-6 text-center text-sm text-fg-muted">
                <p className="text-fg-secondary">{labels.empty.replace('{query}', query.trim())}</p>
                <p className="mt-1">{labels.emptyHint}</p>
              </div>
            ) : null}
          </div>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          <div className="hidden shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-xs text-fg-muted sm:flex">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> {labels.hintMove}
            </span>
            <span>
              <Kbd>Enter</Kbd> {labels.hintOpen}
            </span>
            <span>
              <Kbd>Esc</Kbd> {labels.hintClose}
            </span>
            <span className="ms-auto">
              <Kbd>?</Kbd> {labels.hintShortcuts}
            </span>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

export function Kbd({ children }: { readonly children: string }) {
  return (
    <kbd className="rounded-sm border border-line-control bg-subtle px-1.5 py-0.5 font-sans text-xs text-fg-secondary">
      {children}
    </kbd>
  );
}
