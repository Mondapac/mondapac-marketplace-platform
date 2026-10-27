// The storefront's screen widths: one source of truth for the CSS (globals.css, whose header
// repeats this table) and for every matchMedia query in the code. test/breakpoints.spec.ts keeps
// the CSS to these edges plus an explicit list of older values.
//
//   phone    under 700px
//   tablet   700px to 899px
//   desktop  900px to 1339px
//   wide     1340px and up
//
// Phone and tablet get the bottom tab bar; the side rail starts at the desktop edge.

/** The first width of each range above the phone, in CSS pixels. */
export const BREAKPOINTS = { tablet: 700, desktop: 900, wide: 1340 } as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** The largest width below an edge: a hundredth of a pixel under it, so `max-width` never meets `min-width`. */
export const below = (edge: number): number => Number((edge - 0.02).toFixed(2));

/** `(min-width: 700px)`: this edge and wider. */
export const from = (name: Breakpoint): string => `(min-width: ${BREAKPOINTS[name]}px)`;

/** `(max-width: 699.98px)`: narrower than this edge. */
export const under = (name: Breakpoint): string => `(max-width: ${below(BREAKPOINTS[name])}px)`;

/** Every width the canonical spellings use; the CSS test accepts these in a media query. */
export const CANONICAL_WIDTHS: readonly number[] = Object.values(BREAKPOINTS).flatMap((edge) => [
  below(edge),
  edge,
]);
