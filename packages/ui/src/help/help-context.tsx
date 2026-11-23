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
  type RefObject,
} from 'react';

interface HelpState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Closes the panel and gives focus back to the Help button. */
  readonly close: () => void;
  /** False when the page has no help text: the button is not shown. */
  readonly hasContent: boolean;
  /** The open tab of a page whose tabs have no route (set by `HelpTab`). */
  readonly tab: string | undefined;
  readonly setTab: (label: string | undefined) => void;
  /** The Help button, so closing the panel can return focus to it. */
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly panelId: string;
}

/** From this width the open panel has its own column beside the page (Tailwind `xl`). */
const WIDE_QUERY = '(min-width: 1280px)';

function isWideViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;
}

const HelpContext = createContext<HelpState | null>(null);

export interface HelpProviderProps {
  readonly children: ReactNode;
  /** The id the Help button's `aria-controls` points at. */
  readonly panelId?: string;
  /** False on a page without help text (default true). */
  readonly hasContent?: boolean;
}

/**
 * Holds whether the Help panel is open, so the button in the top bar and the panel beside the page
 * share one state. Escape closes the panel from anywhere on the page. There is no `?` key: it
 * already opens the keyboard shortcuts list (palette/shortcuts.ts).
 */
export function HelpProvider({
  children,
  panelId = 'page-help-panel',
  hasContent = true,
}: HelpProviderProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape inside a modal dialog or side panel belongs to that dialog.
      if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Below 1280 px the panel covers the page, so a tap outside it closes it; from 1280 px the page
  // gives the panel its own column and stays usable beside it. The Help button is outside the
  // panel but toggles it by itself, so it is not an "outside" press.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (isWideViewport()) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.getElementById(panelId)?.contains(target) === true) return;
      if (trigger.current?.contains(target) === true) return;
      // A modal dialog opened from inside the panel is not "outside" either.
      if (target instanceof Element && target.closest('dialog[open]') !== null) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, panelId]);

  const set = useCallback((next: boolean) => setOpen(next), []);
  const value = useMemo(
    () => ({ open, setOpen: set, close, hasContent, tab, setTab, trigger, panelId }),
    [open, set, close, hasContent, tab, panelId],
  );
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

/** The Help state, or null when there is no provider (a page outside the panel shell). */
export function useHelpOptional(): HelpState | null {
  return useContext(HelpContext);
}

export function useHelp(): HelpState {
  const state = useContext(HelpContext);
  if (state === null) throw new Error('Help components need a HelpProvider above them.');
  return state;
}

/**
 * Tells the Help panel which tab is open, by the tab's name in the help text; nothing when the
 * label is undefined or there is no provider. Used by `Tabs` and by `HelpTab`.
 */
export function useHelpTab(label: string | undefined): void {
  const help = useHelpOptional();
  const setTab = help?.setTab;
  useEffect(() => {
    if (label === undefined) return undefined;
    setTab?.(label);
    return () => setTab?.(undefined);
  }, [label, setTab]);
}

/**
 * Put one on a page whose section tabs have no route of their own and are not drawn by `Tabs`:
 * it tells the Help panel which tab is open. It renders nothing.
 */
export function HelpTab({ label }: { readonly label: string }) {
  useHelpTab(label);
  return null;
}
