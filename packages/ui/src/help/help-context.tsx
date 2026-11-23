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
  const trigger = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const set = useCallback((next: boolean) => setOpen(next), []);
  const value = useMemo(
    () => ({ open, setOpen: set, close, hasContent, trigger, panelId }),
    [open, set, close, hasContent, panelId],
  );
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpState {
  const state = useContext(HelpContext);
  if (state === null) throw new Error('Help components need a HelpProvider above them.');
  return state;
}
