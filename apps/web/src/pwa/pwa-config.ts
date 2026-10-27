import { DEFAULT_PALETTE, PALETTE_SWATCHES } from '../preferences/preferences.ts';

/** Browser chrome colour: the default palette's teal (palette B "Trusted Teal"), as the tokens export it. */
export const THEME_COLOR = PALETTE_SWATCHES[DEFAULT_PALETTE][0];

/** Splash background: the page body's colour (--sf-white in globals.css). */
export const BACKGROUND_COLOR = '#ffffff';

/** Placeholder icons from the leaf mark; the real brand icon waits for the brand name. */
export const ICONS = {
  small: '/icons/icon-192.png',
  large: '/icons/icon-512.png',
  maskable: '/icons/icon-512-maskable.png',
  apple: '/icons/apple-touch-icon.png',
} as const;
