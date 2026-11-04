'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icon/icon.tsx';
import {
  canPickMore,
  edgeActive,
  filterOptions,
  moveActive,
  pickedFirst,
  showsSearch,
  togglePick,
  type SearchSelectOption,
} from './search-select-logic.ts';

export type { SearchSelectOption } from './search-select-logic.ts';

/** The words the select shows; the caller passes the panel's own copy. */
export interface SearchSelectLabels {
  readonly search: string;
  readonly noResults: string;
  readonly loading: string;
  readonly retry: string;
  /** "Remove {name}" as the accessible name of a chip's remove button. */
  readonly remove: (name: string) => string;
  /** Shown when the selection cap is reached. */
  readonly limitReached: (max: number) => string;
  readonly none: string;
}

const DEFAULT_LABELS: SearchSelectLabels = {
  search: 'Search',
  noResults: 'No results',
  loading: 'Loading…',
  retry: 'Try again',
  remove: (name) => `Remove ${name}`,
  limitReached: (max) => `You can pick up to ${max}`,
  none: 'None',
};

/** From this many options a plain list gets a search box (john, 31 Oct). */
export const SEARCH_THRESHOLD = 8;
const SEARCH_DEBOUNCE_MS = 250;
const GAP = 4;
const EDGE = 8;
/** Below this viewport width the list is a bottom sheet. */
const SHEET_QUERY = '(max-width: 639px)';

interface BaseProps {
  readonly label: string;
  /** The options to show. With `onSearch` these are the server's answer for the current query. */
  readonly options: readonly SearchSelectOption[];
  readonly placeholder?: string;
  readonly help?: string;
  /** A validation error of the field. */
  readonly error?: string | undefined;
  readonly disabled?: boolean;
  readonly required?: boolean;
  /** The options are being fetched: the list shows a loading row. */
  readonly loading?: boolean;
  /** The fetch failed: the list shows this text with a retry button. */
  readonly loadError?: string | undefined;
  readonly onRetry?: () => void;
  /**
   * Server-side search: called (debounced) with the query whenever it changes, and with '' when
   * the list opens. The options are then not filtered here.
   */
  readonly onSearch?: (query: string) => void;
  /** Show the search box whatever the option count: for lists that grow. */
  readonly alwaysSearch?: boolean;
  readonly searchThreshold?: number;
  readonly labels?: Partial<SearchSelectLabels>;
  readonly name?: string;
}

export interface SearchSelectSingleProps extends BaseProps {
  readonly multiple?: false;
  readonly value: SearchSelectOption | null;
  readonly onChange: (value: SearchSelectOption | null) => void;
  /** A first row that clears the choice, with this text. */
  readonly clearLabel?: string;
}

export interface SearchSelectMultiProps extends BaseProps {
  readonly multiple: true;
  readonly value: readonly SearchSelectOption[];
  readonly onChange: (value: readonly SearchSelectOption[]) => void;
  /** The most that can be picked. */
  readonly max?: number;
}

export type SearchSelectProps = SearchSelectSingleProps | SearchSelectMultiProps;

/**
 * A labelled single or multiple choice list with search. A short plain list stays a list; search
 * shows from {@link SEARCH_THRESHOLD} options and always with `alwaysSearch` or `onSearch` (server
 * search for long lists). The menu has a fixed height and scrolls; on phones it is a bottom sheet.
 * Multiple choice shows the picks as removable chips and keeps them at the top of the list.
 * WAI-ARIA combobox with a listbox: arrows, Home, End, Enter, Escape and type to search; the
 * focused element names the active row with `aria-activedescendant`.
 */
export function SearchSelect(props: SearchSelectProps) {
  const {
    label,
    options,
    placeholder,
    help,
    error,
    disabled = false,
    required = false,
    loading = false,
    loadError,
    onRetry,
    onSearch,
    alwaysSearch = false,
    searchThreshold = SEARCH_THRESHOLD,
    name,
  } = props;
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const multiple = props.multiple === true;
  const picked: readonly SearchSelectOption[] = props.multiple
    ? props.value
    : props.value === null
      ? []
      : [props.value];
  const max = props.multiple ? props.max : undefined;

  const id = useId();
  const listId = `${id}-list`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const server = onSearch !== undefined;

  const searchable = showsSearch({
    optionCount: options.length,
    threshold: searchThreshold,
    always: alwaysSearch,
    server,
  });

  const rows = useMemo(() => {
    const shown = server ? options : filterOptions(options, query);
    return multiple ? pickedFirst(shown, picked) : shown;
    // `picked` is derived from props.value; the rows follow it.
  }, [options, query, server, multiple, props.value]);

  const clearRow = !props.multiple && props.clearLabel !== undefined && props.value !== null;
  const atCap = props.multiple && !canPickMore(picked, max);

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    setQuery('');
    setActive(-1);
    if (focusTrigger) trigger.current?.focus();
  }, []);

  // Server search: the open list asks for '' once, then for the query after a pause.
  useEffect(() => {
    if (!open || onSearch === undefined) return undefined;
    const timer = setTimeout(() => onSearch(query), query === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // onSearch is the caller's function; a new identity per render must not re-ask.
  }, [open, query]);

  // The first enabled row is active while the user types; the chosen row when the list opens.
  useEffect(() => {
    if (!open) return;
    const chosen = rows.findIndex((row) => picked.some((p) => p.value === row.value));
    setActive(query === '' && chosen >= 0 && !multiple ? chosen : edgeActive(rows, 'first'));
  }, [open, query, rows.length]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return undefined;
    }
    const place = () => {
      const phone = window.matchMedia(SHEET_QUERY).matches;
      setSheet(phone);
      const anchor = (box.current ?? trigger.current)?.getBoundingClientRect();
      if (phone || anchor === undefined) {
        setPlace({});
        return;
      }
      const below = window.innerHeight - anchor.bottom - GAP - EDGE;
      const above = anchor.top - GAP - EDGE;
      const openUp = below < 200 && above > below;
      setPlace({
        left: Math.max(anchor.left, EDGE),
        width: Math.min(anchor.width, window.innerWidth - 2 * EDGE),
        maxHeight: Math.max(Math.min(openUp ? above : below, 320), 0),
        ...(openUp
          ? { bottom: window.innerHeight - anchor.top + GAP }
          : { top: anchor.bottom + GAP }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && place !== null) (searchable ? input.current : trigger.current)?.focus();
  }, [open, place === null, searchable]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !box.current?.contains(target)) close(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, close]);

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, id]);

  const choose = (option: SearchSelectOption) => {
    if (option.disabled === true) return;
    if (props.multiple) {
      props.onChange(togglePick(props.value, option, props.max));
      return;
    }
    props.onChange(option);
    close(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        setActive(moveActive(rows, active, 1));
        break;
      case 'ArrowUp':
        setActive(moveActive(rows, active, -1));
        break;
      case 'Home':
        if (searchable) return; // the search box keeps Home and End for its caret
        setActive(edgeActive(rows, 'first'));
        break;
      case 'End':
        if (searchable) return;
        setActive(edgeActive(rows, 'last'));
        break;
      case 'Enter': {
        const row = rows[active];
        if (row !== undefined) choose(row);
        break;
      }
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
  const summary = multiple ? null : (picked[0]?.label ?? null);
  const activeId = open && active >= 0 ? `${id}-opt-${active}` : undefined;

  const body: ReactNode = (
    <>
      {searchable ? (
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" className="text-icon" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label={labels.search}
            aria-expanded={true}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            placeholder={labels.search}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-(--mp-size-control) min-w-0 flex-1 bg-transparent text-fg focus-visible:-outline-offset-2"
          />
        </div>
      ) : null}
      <div
        id={listId}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {clearRow ? (
          <div
            role="option"
            aria-selected={false}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!props.multiple) props.onChange(null);
              close(true);
            }}
            className="flex min-h-(--mp-size-control) cursor-pointer items-center px-4 text-sm text-fg-muted hover:bg-muted"
          >
            {props.multiple ? null : props.clearLabel}
          </div>
        ) : null}
        {loading ? (
          <p role="status" className="px-4 py-3 text-sm text-fg-muted">
            {labels.loading}
          </p>
        ) : loadError !== undefined ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-4 py-3 text-sm">
            <span className="text-critical-fg">{loadError}</span>
            {onRetry === undefined ? null : (
              <button type="button" onClick={onRetry} className="text-link underline">
                {labels.retry}
              </button>
            )}
          </div>
        ) : rows.length === 0 ? (
          <p role="status" className="px-4 py-3 text-sm text-fg-muted">
            {labels.noResults}
          </p>
        ) : (
          rows.map((row, index) => {
            const selected = picked.some((p) => p.value === row.value);
            const blocked = row.disabled === true || (atCap && !selected);
            return (
              <div
                key={row.value}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={selected}
                aria-disabled={blocked || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!blocked && active !== index) setActive(index);
                }}
                onClick={() => {
                  if (!blocked) choose(row);
                }}
                className={[
                  'flex min-h-(--mp-size-control) cursor-pointer items-center gap-2 px-4 py-2 text-start text-sm',
                  blocked ? 'cursor-not-allowed text-fg-muted' : 'text-fg',
                  index === active ? 'bg-muted' : '',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block ${selected ? 'font-medium' : ''}`}>{row.label}</span>
                  {row.description === undefined ? null : (
                    <span className="block text-xs text-fg-muted">{row.description}</span>
                  )}
                </span>
                {selected ? <Icon name="check" className="text-link" /> : null}
              </div>
            );
          })
        )}
      </div>
      {atCap && max !== undefined ? (
        <p className="border-t border-line px-4 py-2 text-xs text-fg-muted">
          {labels.limitReached(max)}
        </p>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-trigger`} className="text-sm font-medium text-fg">
        {label}
      </label>
      <div
        ref={box}
        className={[
          'flex min-h-(--mp-size-control) w-full flex-wrap items-center gap-1.5 rounded-md border bg-surface px-2 py-1',
          error ? 'border-critical-solid' : 'border-line-input',
          disabled ? 'opacity-60' : '',
        ].join(' ')}
      >
        {multiple
          ? picked.map((option) => (
              <span
                key={option.value}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted ps-2 text-sm text-fg"
              >
                <span className="truncate">{option.label}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={labels.remove(option.label)}
                  onClick={() => {
                    if (props.multiple)
                      props.onChange(props.value.filter((v) => v.value !== option.value));
                  }}
                  className="inline-flex size-6 items-center justify-center rounded-md text-icon hover:bg-line"
                >
                  <Icon name="x" />
                </button>
              </span>
            ))
          : null}
        <button
          ref={trigger}
          id={`${id}-trigger`}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && !searchable ? activeId : undefined}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          disabled={disabled}
          onClick={() => (open ? close(false) : setOpen(true))}
          onKeyDown={onKeyDown}
          className="flex min-h-8 min-w-24 flex-1 items-center justify-between gap-2 px-1 text-start text-fg"
        >
          <span className={summary === null ? 'text-fg-muted' : 'truncate'}>
            {summary ?? (multiple && picked.length > 0 ? '' : (placeholder ?? labels.none))}
          </span>
          <Icon name="chevron-down" className="text-icon" />
        </button>
        {name === undefined
          ? null
          : picked.map((option) => (
              <input key={option.value} type="hidden" name={name} value={option.value} />
            ))}
      </div>
      {help ? (
        <p id={helpId} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
      {open
        ? createPortal(
            <>
              {sheet ? <div aria-hidden="true" className="fixed inset-0 z-40 bg-fg/40" /> : null}
              <div
                ref={popup}
                style={{
                  position: 'fixed',
                  ...place,
                  visibility: place === null ? 'hidden' : 'visible',
                }}
                className={[
                  'z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-lg',
                  sheet ? 'inset-x-0 bottom-0 max-h-[70vh] rounded-t-lg' : 'max-h-80 rounded-md',
                ].join(' ')}
              >
                {body}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
