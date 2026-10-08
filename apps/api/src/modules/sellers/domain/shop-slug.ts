import { err, ok, type Result } from '@mondapac/shared-kernel';
import type { ReservedWords } from './reserved-words';

/** A shop slug in its normalised form (sellers design 3.5): a-z, 0-9 and single inner hyphens. */
export type ShopSlug = string & { readonly __shopSlug: true };

/** Why a slug was refused: `slug.format` or `slug.reserved` (design 14.4; Reza 3). */
export type SlugInvalid = { readonly code: 'slug.format' | 'slug.reserved' };

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 50;

/** The CHECK of `shop_slugs.slug` (data design 3.5), minus the length. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The slug a seller typed, compared after lower-casing (brief s7). Only ASCII letters, digits
 * and single hyphens are kept: anything else is a format error, never silently repaired, except
 * that surrounding spaces and upper case are ignored.
 */
export function parseShopSlug(
  raw: unknown,
  reserved: ReservedWords,
): Result<ShopSlug, SlugInvalid> {
  if (typeof raw !== 'string') return err({ code: 'slug.format' });
  const slug = raw.trim().toLowerCase();
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    return err({ code: 'slug.format' });
  }
  // Reserved: the whole slug, or any hyphen-separated token that is a claim word (Hassan M1).
  if (reserved.slugs.has(slug) || slug.split('-').some((token) => reserved.claimWords.has(token))) {
    return err({ code: 'slug.reserved' });
  }
  return ok(slug as ShopSlug);
}
