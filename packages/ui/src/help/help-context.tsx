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
  /** The Help button, so closing the panel can return focus to it. */
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly panelId: string;
}

const HelpContext = createContext<HelpState | null>(null);

/** True when a key press belongs to a field the user is typing in. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/iu.test(target.tagName);
}

export interface HelpProviderProps {
  readonly children: ReactNode;
  /** The id the Help button's `aria-controls` points at. */
  readonly panelId?: string;
}

/**
 * Holds whether the Help panel is open, so the button in the top bar and the panel beside the page
 * share one state. The `?` key toggles the panel unless the user is typing in a field or holds a
 * modifier key.
 */
export function HelpProvider({ children, panelId = 'page-help-panel' }: HelpProviderProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || isTyping(event.target)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const set = useCallback((next: boolean) => setOpen(next), []);
  const value = useMemo(() => ({ open, setOpen: set, trigger, panelId }), [open, set, panelId]);
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpState {
  const state = useContext(HelpContext);
  if (state === null) throw new Error('Help components need a HelpProvider above them.');
  return state;
}
