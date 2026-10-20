import { err, ok, type Result } from '@mondapac/shared-kernel';

/**
 * The storefront looks a customer may keep on the account (buyer account Settings, john 19 Oct):
 * a palette and a text size. They are ids of the storefront's own themes, the same lists as
 * `apps/web/src/preferences/preferences.ts`; a look is added here in the same change that adds
 * it to the storefront. Neither is personal data worth hiding, but both are shown only to their
 * holder.
 */
export const STOREFRONT_PALETTES = ['A', 'B', 'C', 'D'] as const;
export const STOREFRONT_TEXT_SIZES = ['auto', 'large', 'small'] as const;

export type StorefrontPalette = (typeof STOREFRONT_PALETTES)[number];
export type StorefrontTextSize = (typeof STOREFRONT_TEXT_SIZES)[number];

/** A customer's kept look; a null part means "no choice" (the browser's own choice stays). */
export interface StorefrontAppearance {
  readonly palette: StorefrontPalette | null;
  readonly textSize: StorefrontTextSize | null;
}

export type StorefrontAppearanceInvalid = {
  readonly code: 'storefront-appearance.invalid';
  readonly field: 'palette' | 'textSize';
};

function oneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: StorefrontAppearanceInvalid['field'],
): Result<T | null, StorefrontAppearanceInvalid> {
  if (raw === null) return ok(null);
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return err({ code: 'storefront-appearance.invalid', field });
  }
  return ok(raw as T);
}

/** A palette from {@link STOREFRONT_PALETTES}, or null. */
export function parseStorefrontPalette(
  raw: unknown,
): Result<StorefrontPalette | null, StorefrontAppearanceInvalid> {
  return oneOf(raw, STOREFRONT_PALETTES, 'palette');
}

/** A text size from {@link STOREFRONT_TEXT_SIZES}, or null. */
export function parseStorefrontTextSize(
  raw: unknown,
): Result<StorefrontTextSize | null, StorefrontAppearanceInvalid> {
  return oneOf(raw, STOREFRONT_TEXT_SIZES, 'textSize');
}
