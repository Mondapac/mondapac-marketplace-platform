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
  RECENT_LIMIT,
  browserStorage,
  prefsKey,
  pushRecent,
  readFlag,
  readIds,
  resolvePins,
  togglePin,
  writeFlag,
  writeIds,
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
  /** `pin` holds `{page}`; the label stays the same and `aria-pressed` carries the state. */
  readonly pin: { readonly pin: string; readonly limit: string };
  readonly pinned: string;
  readonly shortcuts: {
    readonly title: string;
    readonly close: string;
    readonly openSearch: string;
    readonly showList: string;
    /** "then", between the two keys of a chord. */
    readonly then: string;
    /** The switch for the shortcuts made of one bare key, and its hint (WCAG 2.1.4). */
    readonly singleKey: string;
    readonly singleKeyHint: string;
    /** How to pin a page, without a shortcut. */
    readonly pinHint: string;
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
  readonly goShortcuts: readonly GoShortcut[];
  readonly labels: PanelToolsLabels;
  /** Goes to a path; the browser's own navigation unless a caller (a test) replaces it. */
  readonly navigate?: (href: string) => void;
  readonly children: ReactNode;
}

interface PanelToolsValue {
  readonly labels: PanelToolsLabels;
  readonly openPalette: (opener?: HTMLElement | null) => void;
  readonly openHelp: (opener?: HTMLElement | null) => void;
  readonly pinnedEntries: readonly PaletteEntry[];
  /** The last pages visited, newest first, without the page being viewed. */
  readonly recentEntries: readonly PaletteEntry[];
  /** The page entry the current path belongs to, once known (after the first paint). */
  readonly currentPage: PaletteEntry | undefined;
  /** The path is the page itself, not a screen below it (an order inside Orders). */
  readonly onPageItself: boolean;
  readonly isPinned: (id: string) => boolean;
  readonly toggle: (id: string) => void;
}

const PanelToolsContext = createContext<PanelToolsValue | null>(null);

/** The tools of the shell, or null outside a `PanelTools` (tests, error pages). */
export function usePanelTools(): PanelToolsValue | null {
  return useContext(PanelToolsContext);
}

const HELP_ENTRY_ID = 'action:keyboard-shortcuts';
const pathOf = (href: string): string => href.split('#')[0] ?? href;
const trimPath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * The shell's keyboard and quick-access layer, shared by both panels: the ⌘K palette, the
 * shortcuts dialog, pinned pages and recent pages. Pins, recents and the single-key switch are a
 * per-account convenience kept in localStorage (see `panel-prefs.ts`); the first paint always
 * shows the empty state, so the server and client markup agree.
 */
export function PanelTools({
  panel,
  market,
  accountId,
  entries,
  goShortcuts,
  labels,
  navigate = (href) => window.location.assign(href),
  children,
}: PanelToolsProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const helpOpener = useRef<HTMLElement | null>(null);
  const chordState = useRef<ChordState>(IDLE_CHORD);
  const pageIds = useMemo(
    () => new Set(entries.filter((entry) => entry.kind === 'page').map((entry) => entry.id)),
    [entries],
  );
  const [pins, setPins] = useState<readonly string[]>([]);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [singleKeys, setSingleKeys] = useState(true);
  const [pathname, setPathname] = useState<string | null>(null);
  const pinsKey = prefsKey(panel, market, accountId, 'pins');
  const recentKey = prefsKey(panel, market, accountId, 'recent');
  const singleKeyKey = prefsKey(panel, market, accountId, 'single-key');

  // Reads the saved choices after the first paint and records the page being viewed.
  useEffect(() => {
    const store = browserStorage();
    setPins(resolvePins(readIds(store, pinsKey), pageIds));
    setSingleKeys(readFlag(store, singleKeyKey, true));
    // One more than is shown, so the list still fills when the page being viewed is left out.
    let list: readonly string[] = (readIds(store, recentKey) ?? [])
      .filter((id) => pageIds.has(id))
      .slice(0, RECENT_LIMIT + 1);
    const path = window.location.pathname;
    const here = matchPage(entries, path);
    if (here !== undefined && here.href !== '/') {
      list = pushRecent(list, here.id, RECENT_LIMIT + 1);
      writeIds(store, recentKey, list);
    }
    setRecent(list);
    setPathname(path);
  }, [pinsKey, recentKey, singleKeyKey, entries, pageIds]);

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
  const onPageItself =
    currentPage !== undefined &&
    pathname !== null &&
    pathOf(currentPage.href) === trimPath(pathname);

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

  const openHelp = useCallback((from?: HTMLElement | null) => {
    helpOpener.current =
      from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setHelpOpen(true);
  }, []);

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    const back = helpOpener.current;
    helpOpener.current = null;
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

  const changeSingleKeys = useCallback(
    (value: boolean) => {
      setSingleKeys(value);
      chordState.current = IDLE_CHORD;
      writeFlag(browserStorage(), singleKeyKey, value);
    },
    [singleKeyKey],
  );

  const paletteEntries = useMemo<readonly PaletteEntry[]>(
    () => [
      ...entries,
      {
        id: HELP_ENTRY_ID,
        kind: 'action',
        label: labels.shortcuts.title,
        keywords: labels.shortcuts.openSearch,
        href: '#',
        icon: 'keyboard',
      },
    ],
    [entries, labels.shortcuts.title, labels.shortcuts.openSearch],
  );

  const choose = useCallback(
    (entry: PaletteEntry): boolean => {
      if (entry.id === HELP_ENTRY_ID) {
        // The palette closes and gives focus back to its opener; the list returns it there too.
        helpOpener.current = opener.current;
        setHelpOpen(true);
        return true;
      }
      if (entry.kind === 'page') {
        const next = pushRecent(recent, entry.id, RECENT_LIMIT + 1);
        setRecent(next);
        writeIds(browserStorage(), recentKey, next);
      }
      return false;
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
        singleKeys,
      });
      chordState.current = state;
      if (action.kind === 'palette') {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
      } else if (action.kind === 'help') {
        event.preventDefault();
        openHelp();
      } else if (action.kind === 'chord') {
        const target = goShortcuts.find((shortcut) => shortcut.id === action.chord.id);
        if (target !== undefined) navigate(target.href);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [goShortcuts, singleKeys, paletteOpen, openPalette, closePalette, openHelp, navigate]);

  const recentEntries = useMemo(
    () =>
      resolve(recent)
        .filter((entry) => entry.id !== currentPage?.id)
        .slice(0, RECENT_LIMIT),
    [resolve, recent, currentPage],
  );

  const value = useMemo<PanelToolsValue>(
    () => ({
      labels,
      openPalette,
      openHelp,
      pinnedEntries: resolve(pins),
      recentEntries,
      currentPage,
      onPageItself,
      isPinned: (id) => pins.includes(id),
      toggle,
    }),
    [
      labels,
      openPalette,
      openHelp,
      resolve,
      pins,
      recentEntries,
      currentPage,
      onPageItself,
      toggle,
    ],
  );

  return (
    <PanelToolsContext.Provider value={value}>
      {children}
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        entries={paletteEntries}
        recent={recentEntries}
        labels={labels.palette}
        onChoose={choose}
        navigate={navigate}
      />
      <ShortcutsDialog
        open={helpOpen}
        onClose={closeHelp}
        goShortcuts={goShortcuts}
        labels={labels.shortcuts}
        singleKeys={singleKeys}
        onSingleKeys={changeSingleKeys}
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
  singleKeys,
  onSingleKeys,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly goShortcuts: readonly GoShortcut[];
  readonly labels: PanelToolsLabels['shortcuts'];
  readonly singleKeys: boolean;
  readonly onSingleKeys: (value: boolean) => void;
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
            className={`flex min-h-12 items-center justify-between gap-4 border-b border-line-row last:border-b-0 ${
              !singleKeys && row.id !== 'palette' ? 'opacity-60' : ''
            }`}
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
      <p className="mt-3 text-sm text-fg-muted">{labels.pinHint}</p>
      <label className="mt-3 flex min-h-12 cursor-pointer items-start gap-3 border-t border-line-row pt-3">
        <input
          type="checkbox"
          checked={singleKeys}
          onChange={(event) => onSingleKeys(event.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-accent"
        />
        <span className="flex flex-col">
          <span className="text-fg">{labels.singleKey}</span>
          <span className="text-sm text-fg-muted">{labels.singleKeyHint}</span>
        </span>
      </label>
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

/** The top bar's keyboard button: opens the shortcuts list without a shortcut. From tablets up. */
export function ShortcutsButton() {
  const tools = usePanelTools();
  if (tools === null) return null;
  return (
    <button
      type="button"
      aria-label={tools.labels.shortcuts.title}
      aria-haspopup="dialog"
      title={tools.labels.shortcuts.title}
      onClick={(event) => tools.openHelp(event.currentTarget)}
      className="hidden min-h-11 min-w-11 items-center justify-center rounded-md text-icon hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus md:flex"
    >
      <Icon name="keyboard" />
    </button>
  );
}

/**
 * The phone top bar's title: the name of the page the star pins, so the two agree ("Store
 * profile", not the section "Settings"). Anywhere else the page's own title stands.
 */
export function PageTitle({ fallback }: { readonly fallback: string }) {
  const tools = usePanelTools();
  return <>{tools?.onPageItself === true ? tools.currentPage?.label : fallback}</>;
}

/**
 * The star next to a page title: pins the page to the sidebar, or unpins it. Its name is "Pin
 * {page}" at all times and `aria-pressed` carries the state. Absent on screens below a page.
 */
export function PinButton() {
  const tools = usePanelTools();
  const page = tools?.currentPage;
  if (tools === null || page === undefined || !tools.onPageItself || page.href === '/') return null;
  const pinned = tools.isPinned(page.id);
  const name = tools.labels.pin.pin.replace('{page}', page.label);
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={name}
      title={name}
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
    <div className="mb-2 flex flex-col gap-1 border-b border-line pb-3">
      <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-fg-muted group-data-[rail=true]/rail:sr-only">
        {tools.labels.pinned}
      </p>
      {/* No aria-current here: the page's own menu item carries it, once. */}
      {tools.pinnedEntries.map((entry) => (
        <a
          key={entry.id}
          href={entry.href}
          data-nav-stop="link"
          className="flex min-h-(--mp-size-control) w-full items-center gap-(--mp-space-2-5) rounded-md px-3 py-1 text-fg-secondary hover:bg-muted hover:text-fg group-data-[rail=true]/rail:justify-center"
        >
          <Icon name={entry.icon} className="text-icon" />
          <span className="min-w-0 flex-1 break-words group-data-[rail=true]/rail:sr-only">
            {entry.label}
          </span>
        </a>
      ))}
    </div>
  );
}

/** The recent pages as a row of links (the settings hub); nothing until another page has been viewed. */
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
