'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '../form/button.tsx';
import { toast } from '../feedback/toast-store.ts';
import { Icon } from '../icon/icon.tsx';
import { Dialog } from '../overlay/dialog.tsx';
import { CommandPalette, Kbd, type CommandPaletteLabels } from './command-palette.tsx';
import { matchPage, type PaletteEntry } from './palette-index.ts';
import {
  browserStorage,
  prefsKey,
  pushRecent,
  readIds,
  resolvePins,
  togglePin,
  writeIds,
  RECENT_LIMIT,
} from './panel-prefs.ts';
import { IDLE_CHORD, interpretKey, type Chord, type ChordState } from './shortcuts.ts';

/** A "go to" chord with the text of its row in the shortcuts dialog. */
export interface GoShortcut extends Chord {
  readonly href: string;
  readonly label: string;
}

export interface PanelToolsLabels {
  /** The top bar's search button. */
  readonly search: string;
  readonly palette: CommandPaletteLabels;
  readonly pin: { readonly pin: string; readonly unpin: string; readonly limit: string };
  readonly pinned: string;
  readonly shortcuts: {
    readonly title: string;
    readonly close: string;
    readonly openSearch: string;
    readonly showList: string;
    /** "then", between the two keys of a chord. */
    readonly then: string;
  };
}

export interface PanelToolsProps {
  /** Which panel, for the storage key ("admin", "seller"). */
  readonly panel: string;
  /** The Market id of the host, for the storage key. */
  readonly market: string;
  readonly accountId: string;
  /** Every page, setting and action the account may open (`buildPaletteEntries`). */
  readonly entries: readonly PaletteEntry[];
  /** Entry ids pinned for an account that has chosen nothing yet (3 per role). */
  readonly defaultPinIds: readonly string[];
  readonly goShortcuts: readonly GoShortcut[];
  readonly labels: PanelToolsLabels;
  /** Goes to a path; the browser's own navigation unless a caller (a test) replaces it. */
  readonly navigate?: (href: string) => void;
  readonly children: ReactNode;
}

interface PanelToolsValue {
  readonly labels: PanelToolsLabels;
  readonly openPalette: (opener?: HTMLElement | null) => void;
  readonly pinnedEntries: readonly PaletteEntry[];
  readonly recentEntries: readonly PaletteEntry[];
  /** The page entry the current path belongs to, once known (after the first paint). */
  readonly currentPage: PaletteEntry | undefined;
  readonly isPinned: (id: string) => boolean;
  readonly toggle: (id: string) => void;
}

const PanelToolsContext = createContext<PanelToolsValue | null>(null);

/** The tools of the shell, or null outside a `PanelTools` (tests, error pages). */
export function usePanelTools(): PanelToolsValue | null {
  return useContext(PanelToolsContext);
}

/**
 * The shell's keyboard and quick-access layer, shared by both panels: the ⌘K palette, the
 * shortcuts dialog, pinned pages and recent pages. Pins and recents are a per-account convenience
 * kept in localStorage (see `panel-prefs.ts`); the first paint always shows the defaults, so the
 * server and client markup agree.
 */
export function PanelTools({
  panel,
  market,
  accountId,
  entries,
  defaultPinIds,
  goShortcuts,
  labels,
  navigate = (href) => window.location.assign(href),
  children,
}: PanelToolsProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const chordState = useRef<ChordState>(IDLE_CHORD);
  const pageIds = useMemo(
    () => new Set(entries.filter((entry) => entry.kind === 'page').map((entry) => entry.id)),
    [entries],
  );
  const [pins, setPins] = useState<readonly string[]>(() =>
    resolvePins(undefined, defaultPinIds, pageIds),
  );
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [pathname, setPathname] = useState<string | null>(null);
  const pinsKey = prefsKey(panel, market, accountId, 'pins');
  const recentKey = prefsKey(panel, market, accountId, 'recent');

  // Reads the saved lists after the first paint and records the page being viewed.
  useEffect(() => {
    const store = browserStorage();
    setPins(resolvePins(readIds(store, pinsKey), defaultPinIds, pageIds));
    let list: readonly string[] = (readIds(store, recentKey) ?? [])
      .filter((id) => pageIds.has(id))
      .slice(0, RECENT_LIMIT);
    const path = window.location.pathname;
    const here = matchPage(entries, path);
    if (here !== undefined && here.href !== '/') {
      list = pushRecent(list, here.id);
      writeIds(store, recentKey, list);
    }
    setRecent(list);
    setPathname(path);
  }, [pinsKey, recentKey, entries, defaultPinIds, pageIds]);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const resolve = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const entry = byId.get(id);
        return entry === undefined ? [] : [entry];
      }),
    [byId],
  );
  const currentPage = pathname === null ? undefined : matchPage(entries, pathname);

  const openPalette = useCallback((from?: HTMLElement | null) => {
    opener.current =
      from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setHelpOpen(false);
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    const back = opener.current;
    opener.current = null;
    // The dialog gives focus back itself in a browser; this also covers an opener it lost.
    if (back?.isConnected) back.focus();
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const change = togglePin(pins, id);
      if (change.kind === 'limit') {
        toast.warning(labels.pin.limit, { id: 'pin-limit' });
        return;
      }
      setPins(change.pins);
      writeIds(browserStorage(), pinsKey, change.pins);
    },
    [pins, pinsKey, labels.pin.limit],
  );

  const choose = useCallback(
    (entry: PaletteEntry) => {
      if (entry.kind !== 'page') return;
      const next = pushRecent(recent, entry.id);
      setRecent(next);
      writeIds(browserStorage(), recentKey, next);
    },
    [recent, recentKey],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { action, state } = interpretKey(event, {
        target: event.target,
        modalOpen: document.querySelector('dialog[open]') !== null,
        state: chordState.current,
        now: Date.now(),
        chords: goShortcuts,
      });
      chordState.current = state;
      if (action.kind === 'palette') {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
      } else if (action.kind === 'help') {
        event.preventDefault();
        setHelpOpen(true);
      } else if (action.kind === 'chord') {
        const target = goShortcuts.find((shortcut) => shortcut.id === action.chord.id);
        if (target !== undefined) navigate(target.href);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [goShortcuts, paletteOpen, openPalette, closePalette, navigate]);

  const value = useMemo<PanelToolsValue>(
    () => ({
      labels,
      openPalette,
      pinnedEntries: resolve(pins),
      recentEntries: resolve(recent),
      currentPage,
      isPinned: (id) => pins.includes(id),
      toggle,
    }),
    [labels, openPalette, resolve, pins, recent, currentPage, toggle],
  );

  return (
    <PanelToolsContext.Provider value={value}>
      {children}
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        entries={entries}
        recent={value.recentEntries}
        labels={labels.palette}
        onChoose={choose}
        navigate={navigate}
      />
      <ShortcutsDialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        goShortcuts={goShortcuts}
        labels={labels.shortcuts}
      />
    </PanelToolsContext.Provider>
  );
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere; the first paint says Ctrl so both sides agree. */
function useModifierLabel(): string {
  const [label, setLabel] = useState('Ctrl');
  useEffect(() => {
    if (/Mac|iPhone|iPad/i.test(navigator.platform)) setLabel('⌘');
  }, []);
  return label;
}

function ShortcutsDialog({
  open,
  onClose,
  goShortcuts,
  labels,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly goShortcuts: readonly GoShortcut[];
  readonly labels: PanelToolsLabels['shortcuts'];
}) {
  const modifier = useModifierLabel();
  const rows: readonly { id: string; label: string; keys: readonly string[] }[] = [
    { id: 'palette', label: labels.openSearch, keys: [modifier, 'K'] },
    ...goShortcuts.map((shortcut) => ({
      id: shortcut.id,
      label: shortcut.label,
      keys: [shortcut.keys[0].toUpperCase(), labels.then, shortcut.keys[1].toUpperCase()],
    })),
    { id: 'help', label: labels.showList, keys: ['?'] },
  ];
  return (
    <Dialog
      open={open}
      title={labels.title}
      onClose={onClose}
      actions={
        <Button variant="secondary" className="min-h-12" onClick={onClose}>
          {labels.close}
        </Button>
      }
    >
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex min-h-12 items-center justify-between gap-4 border-b border-line-row last:border-b-0"
          >
            <dt className="min-w-0 break-words text-fg">{row.label}</dt>
            <dd className="flex shrink-0 items-center gap-1.5 text-sm text-fg-muted">
              {row.keys.map((key, index) =>
                key === labels.then ? (
                  <span key={`${key}-${index}`}>{key}</span>
                ) : (
                  <Kbd key={`${key}-${index}`}>{key}</Kbd>
                ),
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/** The top bar's search control: opens the palette, and shows the shortcut where there is a keyboard. */
export function PaletteSearchButton() {
  const tools = usePanelTools();
  const modifier = useModifierLabel();
  if (tools === null) return null;
  return (
    <button
      type="button"
      aria-label={tools.labels.search}
      aria-haspopup="dialog"
      onClick={(event) => tools.openPalette(event.currentTarget)}
      className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border-line-control px-3 text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus md:min-h-10 md:border md:bg-subtle"
    >
      <Icon name="search" />
      <span className="hidden md:inline">{tools.labels.search}</span>
      <span className="hidden items-center gap-1 lg:flex">
        <Kbd>{modifier}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}

/** The star next to a page title: pins the page to the sidebar, or unpins it. Absent on other pages. */
export function PinButton() {
  const tools = usePanelTools();
  const page = tools?.currentPage;
  if (tools === null || page === undefined || page.href === '/') return null;
  const pinned = tools.isPinned(page.id);
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? tools.labels.pin.unpin : tools.labels.pin.pin}
      onClick={() => tools.toggle(page.id)}
      className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-focus ${pinned ? 'text-attention-solid' : 'text-icon'}`}
    >
      <Icon name="star" className={pinned ? 'fill-current' : ''} />
    </button>
  );
}

/** The sidebar's "Pinned" section; nothing when no page is pinned or outside a `PanelTools`. */
export function PinnedSection() {
  const tools = usePanelTools();
  if (tools === null || tools.pinnedEntries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pb-1">
      <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-fg-muted group-data-[rail=true]/rail:sr-only">
        {tools.labels.pinned}
      </p>
      {tools.pinnedEntries.map((entry) => (
        <a
          key={entry.id}
          href={entry.href}
          data-nav-stop="link"
          aria-current={tools.currentPage?.id === entry.id ? 'page' : undefined}
          className={`flex min-h-(--mp-size-control) w-full items-center gap-(--mp-space-2-5) rounded-md px-3 py-1 group-data-[rail=true]/rail:justify-center ${
            tools.currentPage?.id === entry.id
              ? 'bg-selected font-medium text-link'
              : 'text-fg-secondary hover:bg-muted hover:text-fg'
          }`}
        >
          <Icon
            name={entry.icon}
            className={tools.currentPage?.id === entry.id ? '' : 'text-icon'}
          />
          <span className="min-w-0 flex-1 break-words group-data-[rail=true]/rail:sr-only">
            {entry.label}
          </span>
        </a>
      ))}
    </div>
  );
}

/** The recent pages as a row of links (the settings hub); nothing until a page has been viewed. */
export function RecentPages({ heading }: { readonly heading: string }) {
  const tools = usePanelTools();
  if (tools === null || tools.recentEntries.length === 0) return null;
  return (
    <section aria-labelledby="recent-pages-heading" className="flex flex-col gap-2">
      <h2 id="recent-pages-heading" className="text-sm font-semibold text-fg-secondary">
        {heading}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {tools.recentEntries.map((entry) => (
          <li key={entry.id}>
            <a
              href={entry.href}
              className="inline-flex min-h-12 items-center gap-2 rounded-md border border-line bg-surface px-3 text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-focus"
            >
              <Icon name={entry.icon} className="text-icon" />
              <span className="break-words">{entry.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
