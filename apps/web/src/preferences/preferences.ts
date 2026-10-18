// Buyer display preferences, kept per browser in cookies so the server renders the chosen look
// on the first paint. A signed-in customer's choice moves to their profile when the
// personalization API offers it.

export const PALETTES = ['B', 'A', 'C', 'D'] as const;
export type Palette = (typeof PALETTES)[number];
export const DEFAULT_PALETTE: Palette = 'B';
export const PALETTE_COOKIE = 'sf-palette';

export const TEXT_SIZES = ['auto', 'large', 'small'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_COOKIE = 'sf-text-size';

/** The brand colours of each palette, for the picker's swatches only. */
export const PALETTE_SWATCHES: Record<Palette, readonly [string, string, string]> = {
  B: ['#0E5A57', '#237A72', '#F2A93B'],
  A: ['#B4462B', '#4A2545', '#66733A'],
  C: ['#283372', '#B0305A', '#A8C56A'],
  D: ['#4B22D6', '#FF5C4D', '#FFB627'],
};

export function paletteOf(value: string | undefined): Palette {
  return (PALETTES as readonly string[]).includes(value ?? '')
    ? (value as Palette)
    : DEFAULT_PALETTE;
}

export function textSizeOf(value: string | undefined): TextSize {
  return (TEXT_SIZES as readonly string[]).includes(value ?? '') ? (value as TextSize) : 'auto';
}

const YEAR = 60 * 60 * 24 * 365;

/** Applies a preference to the page now and keeps it for the next visit. */
export function savePreference(cookie: string, attribute: 'palette' | 'textSize', value: string) {
  const root = document.documentElement;
  if (value === 'auto') delete root.dataset[attribute];
  else root.dataset[attribute] = value;
  document.cookie = `${cookie}=${value}; Path=/; Max-Age=${YEAR}; SameSite=Lax; Secure`;
}
