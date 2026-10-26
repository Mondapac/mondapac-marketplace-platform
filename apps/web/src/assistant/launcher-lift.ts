// Where the assistant launcher sits above the bottom of the screen, so it never lands on another
// sticky layer: the dock (tab bar and cookie bar), the page's action bar (the product's buy bar,
// the cart's checkout bar) and, at the end of the page, the footer's back-to-top button.

/** The launcher's side (the CSS gives it 56px). */
export const LAUNCHER_SIZE = 56;
/** The resting distance from the bottom edge, and the clearance above any layer below it. */
export const LAUNCHER_REST = 20;
export const LAUNCHER_CLEARANCE = 12;

/** A box in viewport coordinates, as getBoundingClientRect gives it; null when it is not shown. */
export type Box = { readonly top: number; readonly bottom: number } | null;

export type Lift = {
  /** How much of the screen's bottom the dock covers (the assistant panel stays clear of it). */
  readonly dock: number;
  /** The launcher's distance from the bottom edge. */
  readonly lift: number;
  /** True when the launcher lines up with the back-to-top button. */
  readonly alignBackToTop: boolean;
};

export function launcherLift(
  viewportHeight: number,
  dock: Box,
  actionBars: readonly Box[],
  backToTop: Box,
): Lift {
  const covered = dock !== null && dock.top < viewportHeight ? viewportHeight - dock.top : 0;
  let lift = Math.max(LAUNCHER_REST, covered + LAUNCHER_CLEARANCE);
  // An action bar the launcher would overlap (stuck above the dock, or released and scrolling by):
  // the launcher goes above it. Decided from the launcher's resting place, so scrolling cannot
  // make it flip back and forth.
  const launcherTop = viewportHeight - lift - LAUNCHER_SIZE;
  const launcherBottom = viewportHeight - lift;
  for (const bar of actionBars) {
    if (bar === null || bar.bottom <= launcherTop || bar.top >= launcherBottom) continue;
    lift = Math.max(lift, viewportHeight - bar.top + LAUNCHER_CLEARANCE);
  }
  let alignBackToTop = false;
  if (backToTop !== null && backToTop.top < viewportHeight - covered && backToTop.bottom > 0) {
    lift = Math.max(lift, viewportHeight - backToTop.top + LAUNCHER_CLEARANCE);
    alignBackToTop = true;
  }
  return { dock: covered, lift, alignBackToTop };
}

/**
 * On a phone the launcher hides while the cookie bar is open: the bar fills the bottom of a small
 * screen, and the launcher above it would cover the page (Reza, cookie bar compact pass). It comes
 * back once the buyer chooses. Tablet and desktop keep it above the dock.
 */
export function launcherHidden(phone: boolean, cookieBarOpen: boolean): boolean {
  return phone && cookieBarOpen;
}
