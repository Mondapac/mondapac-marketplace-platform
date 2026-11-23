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

  const set = useCallback((next: boolean) => setOpen(next), []);
  const value = useMemo(
    () => ({ open, setOpen: set, close, hasContent, tab, setTab, trigger, panelId }),
    [open, set, close, hasContent, tab, panelId],
  );
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpState {
  const state = useContext(HelpContext);
  if (state === null) throw new Error('Help components need a HelpProvider above them.');
  return state;
}

/**
 * Put one on a page whose section tabs have no route of their own: it tells the Help panel which
 * tab is open, by the tab's label in the help text. It renders nothing.
 */
export function HelpTab({ label }: { readonly label: string }) {
  const { setTab } = useHelp();
  useEffect(() => {
    setTab(label);
    return () => setTab(undefined);
  }, [label, setTab]);
  return null;
}
