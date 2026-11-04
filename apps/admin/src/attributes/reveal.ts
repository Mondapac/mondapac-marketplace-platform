import { useEffect, type RefObject } from 'react';

/** Below 1024 px the details sit under the list (Reza, A1 review). */
const STACKED = '(max-width: 1023.98px)';

/**
 * When the panel's content for `key` is ready on a narrow screen, scrolls the panel into view and
 * moves focus to its heading, so choosing a row far up the list shows its details at once.
 */
export function useRevealWhenStacked(
  panel: RefObject<HTMLElement | null>,
  key: string | null,
  ready: boolean,
): void {
  useEffect(() => {
    if (!ready || key === null) return;
    const element = panel.current;
    if (element === null || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia(STACKED).matches) return;
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'start' });
    }
    element.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [panel, key, ready]);
}
