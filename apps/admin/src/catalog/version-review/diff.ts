// What a product version changes against the published one, field by field. Pure: the page
// marks each change with a word and a sign (+ added, − removed), never with colour only.
import type { RevisionContent, RevisionImage, RevisionText, RevisionVariant } from './types.ts';

export type Change = 'same' | 'added' | 'removed' | 'changed';

export interface TextDiff {
  readonly locale: string;
  readonly field: keyof RevisionText;
  readonly before: string | null;
  readonly after: string | null;
  readonly change: Change;
}

const FIELDS: readonly (keyof RevisionText)[] = ['name', 'shortDescription', 'description'];

function changeOf<T>(before: T | null, after: T | null, same: (a: T, b: T) => boolean): Change {
  if (before === null && after === null) return 'same';
  if (before === null) return 'added';
  if (after === null) return 'removed';
  return same(before, after) ? 'same' : 'changed';
}

const blank = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === '' ? null : value;

/**
 * The texts per locale, the default locale first then the others in order. `published` null (a
 * first publication) makes every text "added".
 */
export function textDiffs(
  revision: RevisionContent,
  published: RevisionContent | null,
  defaultLocale: string,
): readonly {
  readonly locale: string;
  readonly rows: readonly TextDiff[];
  readonly changed: boolean;
}[] {
  const locales = [
    ...new Set([...Object.keys(revision.texts), ...Object.keys(published?.texts ?? {})]),
  ];
  locales.sort((a, b) => (a === defaultLocale ? -1 : b === defaultLocale ? 1 : a.localeCompare(b)));
  return locales.map((locale) => {
    const rows = FIELDS.map((field) => {
      const before = blank(published?.texts[locale]?.[field]);
      const after = blank(revision.texts[locale]?.[field]);
      return { locale, field, before, after, change: changeOf(before, after, (a, b) => a === b) };
    });
    return { locale, rows, changed: rows.some((row) => row.change !== 'same') };
  });
}

export interface ListDiff {
  readonly id: string;
  readonly change: Change;
}

/** Ids in the version's order, then the removed ones in the published order. */
export function idDiffs(
  after: readonly string[],
  before: readonly string[] | null,
): readonly ListDiff[] {
  const old = new Set(before ?? []);
  const now = new Set(after);
  return [
    ...after.map((id) => ({ id, change: old.has(id) ? ('same' as const) : ('added' as const) })),
    ...(before ?? [])
      .filter((id) => !now.has(id))
      .map((id) => ({ id, change: 'removed' as const })),
  ];
}

export interface VariantDiff {
  readonly variantId: string;
  readonly before: RevisionVariant | null;
  readonly after: RevisionVariant | null;
  readonly change: Change;
}

const variantKey = (variant: RevisionVariant) =>
  JSON.stringify([
    Object.entries(variant.optionValues).sort(),
    Object.entries(variant.labels).sort(),
    variant.gtin,
    variant.shippingWeightGrams,
    variant.shippingLengthMm,
    variant.shippingWidthMm,
    variant.shippingHeightMm,
    variant.imageIds,
  ]);

/** Variants by id: in the version's order, then the removed ones. */
export function variantDiffs(
  revision: RevisionContent,
  published: RevisionContent | null,
): readonly VariantDiff[] {
  const old = new Map((published?.variants ?? []).map((variant) => [variant.variantId, variant]));
  const now = new Set(revision.variants.map((variant) => variant.variantId));
  const ordered = [...revision.variants].sort((a, b) => a.position - b.position);
  return [
    ...ordered.map((after) => {
      const before = old.get(after.variantId) ?? null;
      return {
        variantId: after.variantId,
        before,
        after,
        change: changeOf(before, after, (a, b) => variantKey(a) === variantKey(b)),
      };
    }),
    ...(published?.variants ?? [])
      .filter((variant) => !now.has(variant.variantId))
      .map((before) => ({
        variantId: before.variantId,
        before,
        after: null,
        change: 'removed' as const,
      })),
  ];
}

export interface AttributeDiff {
  readonly code: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly change: Change;
}

/** Only the attributes the version adds, removes or changes, by code. */
export function attributeDiffs(
  revision: RevisionContent,
  published: RevisionContent | null,
): readonly AttributeDiff[] {
  const before = published?.attributeValues ?? {};
  const after = revision.attributeValues;
  const codes = [...new Set([...Object.keys(after), ...Object.keys(before)])].sort();
  return codes
    .map((code) => {
      const a = code in before ? before[code] : null;
      const b = code in after ? after[code] : null;
      return {
        code,
        before: a,
        after: b,
        change: changeOf<unknown>(
          a ?? null,
          b ?? null,
          (x, y) => JSON.stringify(x) === JSON.stringify(y),
        ),
      };
    })
    .filter((row) => row.change !== 'same');
}

/** An attribute value as text: a string, a number, a list, or a locale map (default locale). */
export function attributeText(value: unknown, locale: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => attributeText(item, locale)).join(', ');
  if (typeof value === 'object') {
    const map = value as Record<string, unknown>;
    if (locale in map) return attributeText(map[locale], locale);
    return Object.entries(map)
      .map(([key, item]) => `${key}: ${attributeText(item, locale)}`)
      .join('; ');
  }
  return '';
}

export type PhotoMark = 'new' | 'kept' | 'taken-down';

export interface PhotoTile {
  readonly imageId: string;
  readonly position: number;
  readonly mark: PhotoMark;
}

/**
 * The version's photos in order with their mark: taken down (never served), new (not in the
 * published version), or kept.
 */
export function photoTiles(
  images: readonly RevisionImage[],
  publishedIds: readonly string[] | null,
): readonly PhotoTile[] {
  const old = new Set(publishedIds ?? []);
  return [...images]
    .sort((a, b) => a.position - b.position)
    .map((image) => ({
      imageId: image.imageId,
      position: image.position,
      mark: image.state === 'taken-down' ? 'taken-down' : old.has(image.imageId) ? 'kept' : 'new',
    }));
}
