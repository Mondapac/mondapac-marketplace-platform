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
  readonly recent: string;
  readonly kind: Readonly<Record<PaletteKind, string>>;
  /** "No results for “{query}”"; `{query}` is replaced. */
  readonly empty: string;
  /** Live announcement: "1 result" and "{count} results". */
  readonly countOne: string;
  readonly countMany: string;
  /** Footer hints, shown from tablets up where a keyboard is likely. */
  readonly hintMove: string;
  readonly hintOpen: string;
  readonly hintClose: string;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly entries: readonly PaletteEntry[];
  /** The recently visited pages, newest first; shown while the field is empty. */
  readonly recent: readonly PaletteEntry[];
  readonly labels: CommandPaletteLabels;
  /** Called when an entry is chosen, before the browser goes there. */
  readonly onChoose: (entry: PaletteEntry) => void;
  /** Goes to a path; the browser's own navigation unless a caller (a test) replaces it. */
  readonly navigate?: (href: string) => void;
}

interface Section {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly PaletteEntry[];
}

const KIND_ORDER: readonly PaletteKind[] = ['page', 'setting', 'action'];

/**
 * The ⌘K palette: a modal dialog holding a combobox (the search field) and a listbox (the
 * results), after the WAI-ARIA combobox pattern. Focus stays in the field; the arrow keys move the
 * active option (`aria-activedescendant`), Enter opens it, Escape closes. With an empty field it
 * lists the recent pages and the actions. A live region announces how many results there are.
 */
export function CommandPalette({
  open,
  onClose,
  entries,
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
      return [
        { id: 'recent', heading: labels.recent, items: recent },
        { id: 'action', heading: labels.kind.action, items: actions },
      ].filter((section) => section.items.length > 0);
    }
    const hits = searchPalette(entries, query);
    return KIND_ORDER.map((kind) => ({
      id: kind,
      heading: labels.kind[kind],
      items: hits.filter((hit) => hit.kind === kind),
    })).filter((section) => section.items.length > 0);
  }, [entries, recent, query, labels]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const optionId = (index: number) => `${base}-option-${index}`;
  const current = active >= 0 && active < flat.length ? active : -1;

  useEffect(() => {
    if (current >= 0) {
      document.getElementById(optionId(current))?.scrollIntoView?.({ block: 'nearest' });
    }
    // optionId only depends on `base`.
  }, [current, flat]);

  function choose(entry: PaletteEntry) {
    onChoose(entry);
    onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Home and End stay with the text field (they move its caret), as in the APG combobox.
    if (isListKey(event.key) && event.key !== 'Home' && event.key !== 'End') {
      event.preventDefault();
      setActive(moveActive(current, flat.length, event.key));
    } else if (event.key === 'Enter') {
      const entry = flat[current];
      if (entry === undefined) return;
      event.preventDefault();
      onChoose(entry);
      onClose();
      navigate(entry.href);
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
      className="m-0 h-dvh max-h-none w-full max-w-none overflow-hidden rounded-none border-0 bg-surface p-0 text-start text-fg backdrop:bg-fg/40 sm:mx-auto sm:mt-[10vh] sm:mb-auto sm:h-fit sm:max-h-[min(34rem,80dvh)] sm:w-[min(40rem,calc(100%-2rem))] sm:rounded-lg sm:border sm:border-line"
    >
      {open ? (
        <div className="flex h-full max-h-dvh flex-col sm:h-auto sm:max-h-[min(34rem,80dvh)]">
          <div className="flex shrink-0 items-center border-b border-line">
            <span className="ps-4 text-icon">
              <Icon name="search" />
            </span>
            <input
              ref={field}
              type="text"
              role="combobox"
              aria-label={labels.title}
              aria-expanded="true"
              aria-controls={`${base}-list`}
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
              // The global focus ring would fall outside the dialog's clipped edge: draw it inside.
              style={{ outlineOffset: -2 }}
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
          <div
            id={`${base}-list`}
            role="listbox"
            aria-label={labels.results}
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
                      onClick={() => choose(entry)}
                      onMouseMove={() => {
                        if (mine !== current) setActive(mine);
                      }}
                      className={`flex min-h-12 items-center gap-3 rounded-md px-3 py-2 text-fg ${mine === current ? 'bg-selected' : ''}`}
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
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                {labels.empty.replace('{query}', query.trim())}
              </p>
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
