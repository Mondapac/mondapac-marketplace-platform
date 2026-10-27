// When the bottom tab bar hides on a long page: down hides it, up or the top shows it. The pure
// part (the rules, tested alone); shell/tabbar-autohide.tsx wires it to the scroll position.

/** Scrolling down this far (px) from the last high point hides the bar. */
export const HIDE_AFTER = 12;
/** Scrolling up this far (px) from the last low point shows it again (more than HIDE_AFTER, so a
 *  small flick back does not bring it back). */
export const SHOW_AFTER = 32;
/** At or above this scroll position (px) the bar is always shown. */
export const TOP_ZONE = 8;

export type TabBarScroll = {
  readonly hidden: boolean;
  /** The turning point: the highest position since the bar was shown, or the lowest since hidden. */
  readonly anchor: number;
};

export const INITIAL_SCROLL: TabBarScroll = { hidden: false, anchor: 0 };

/**
 * The next state for a scroll position `y` on a page that can scroll up to `max`. A position
 * outside 0..max is an iOS bounce (rubber-band) and changes nothing; at the top the bar shows.
 */
export function nextTabBar(state: TabBarScroll, y: number, max: number): TabBarScroll {
  if (!Number.isFinite(y) || y < 0 || y > Math.max(0, max)) return state;
  if (y <= TOP_ZONE)
    return state.hidden || state.anchor !== y ? { hidden: false, anchor: y } : state;
  if (!state.hidden) {
    const anchor = Math.min(state.anchor, y);
    return y - anchor >= HIDE_AFTER ? { hidden: true, anchor: y } : { hidden: false, anchor };
  }
  const anchor = Math.max(state.anchor, y);
  return anchor - y >= SHOW_AFTER ? { hidden: false, anchor: y } : { hidden: true, anchor };
}
