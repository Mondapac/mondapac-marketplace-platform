import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { ClaimCheckedFieldId } from './claim-checked-fields';

/**
 * The texts of a working copy and the closed shape that holds them (catalog design 6.1, 6.2):
 * the draft is checked field by field, so the check must find every string the draft would
 * store. The shape is closed: a key, a locale or a nesting the draft does not know is refused as
 * a whole (`working-copy.invalid-content`), never skipped, so no text can sit where the check does
 * not look. Pure functions, no I/O.
 */

/** One step of a path: a key, or the variant with this id (the array order may change). */
export type DraftStep = string | { readonly variantId: string };

/** A checked text of the draft and the place where a refused one is put back. */
export interface DraftText {
  readonly field: ClaimCheckedFieldId;
  readonly ref: string | null;
  readonly locale: string;
  readonly text: string;
  /** The value to keep or restore as a unit: a string, or a whole attribute value. */
  readonly path: readonly DraftStep[];
}

/** A code, an id or a locale key as the draft may hold it: bounded, no free text. */
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LIST = 500;
const TOP_KEYS = [
  'texts',
  'categoryIds',
  'taxCategoryCode',
  'attributeValues',
  'variants',
  'imageIds',
];
const TEXT_KEYS = ['name', 'shortDescription', 'description'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Invalid = { readonly code: 'working-copy.invalid-content' };
const invalid: Result<never, Invalid> = err({ code: 'working-copy.invalid-content' });

function closedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function idList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_LIST &&
      value.every((item) => typeof item === 'string' && KEY.test(item)))
  );
}

/**
 * Walks a draft and answers every checked text with its place, or `working-copy.invalid-content`
 * when the draft holds anything the closed shape does not name. `defaultLocale` is the locale of
 * a text that is not localizable.
 */
export function draftTextsOf(
  content: Readonly<Record<string, unknown>>,
  supportedLocales: readonly string[],
  defaultLocale: string,
): Result<DraftText[], Invalid> {
  const found: DraftText[] = [];
  if (!closedKeys(content, TOP_KEYS)) return invalid;
  if (!idList(content['categoryIds']) || !idList(content['imageIds'])) return invalid;
  const tax = content['taxCategoryCode'];
  if (tax !== undefined && (typeof tax !== 'string' || !KEY.test(tax))) return invalid;

  const texts = content['texts'];
  if (texts !== undefined) {
    if (!isObject(texts)) return invalid;
    for (const [locale, entry] of Object.entries(texts)) {
      if (!supportedLocales.includes(locale) || !isObject(entry) || !closedKeys(entry, TEXT_KEYS)) {
        return invalid;
      }
      for (const key of TEXT_KEYS) {
        const value = entry[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return invalid;
        found.push({
          field:
            key === 'name'
              ? 'product.name'
              : key === 'shortDescription'
                ? 'product.short-description'
                : 'product.description',
          ref: null,
          locale,
          text: value,
          path: ['texts', locale, key],
        });
      }
    }
  }

  const attributes = content['attributeValues'];
  if (attributes !== undefined) {
    if (!isObject(attributes) || Object.keys(attributes).length > MAX_LIST) return invalid;
    for (const [code, value] of Object.entries(attributes)) {
      if (!KEY.test(code)) return invalid;
      const path = ['attributeValues', code];
      const place = (locale: string, text: string): DraftText => ({
        field: 'product.attribute-text-value',
        ref: code,
        locale,
        text,
        path,
      });
      if (typeof value === 'string') found.push(place(defaultLocale, value));
      else if (value === null || typeof value === 'number' || typeof value === 'boolean') continue;
      else if (Array.isArray(value)) {
        if (value.length > MAX_LIST || !value.every((item) => typeof item === 'string')) {
          return invalid;
        }
        for (const item of value) found.push(place(defaultLocale, item));
      } else if (isObject(value)) {
        for (const [locale, text] of Object.entries(value)) {
          if (!supportedLocales.includes(locale) || typeof text !== 'string') return invalid;
          found.push(place(locale, text));
        }
      } else return invalid;
    }
  }

  const variants = content['variants'];
  if (variants !== undefined) {
    if (!Array.isArray(variants) || variants.length > MAX_LIST) return invalid;
    const seenIds = new Set<string>();
    for (const variant of variants as unknown[]) {
      if (!isObject(variant) || !closedKeys(variant, ['variantId', 'optionValues', 'labels'])) {
        return invalid;
      }
      const variantId = variant['variantId'];
      if (typeof variantId !== 'string' || !KEY.test(variantId)) return invalid;
      // A path names a variant by id, so a repeated id would hide the second one's texts from the check.
      if (seenIds.has(variantId)) return invalid;
      seenIds.add(variantId);
      const options = variant['optionValues'];
      if (options !== undefined) {
        if (!isObject(options)) return invalid;
        for (const [code, option] of Object.entries(options)) {
          if (!KEY.test(code) || typeof option !== 'string' || !KEY.test(option)) return invalid;
        }
      }
      const labels = variant['labels'];
      if (labels !== undefined) {
        if (!isObject(labels)) return invalid;
        for (const [locale, label] of Object.entries(labels)) {
          if (!supportedLocales.includes(locale) || typeof label !== 'string') return invalid;
          found.push({
            field: 'product.variant-label',
            ref: variantId,
            locale,
            text: label,
            path: ['variants', { variantId }, 'labels', locale],
          });
        }
      }
    }
  }
  return ok(found);
}

function child(parent: unknown, step: DraftStep): unknown {
  if (typeof step === 'string') return isObject(parent) ? parent[step] : undefined;
  return Array.isArray(parent)
    ? (parent as unknown[]).find((item) => isObject(item) && item['variantId'] === step.variantId)
    : undefined;
}

/** The value at `path`, or `undefined` when the draft has nothing there. */
export function valueAt(content: unknown, path: readonly DraftStep[]): unknown {
  return path.reduce<unknown>((node, step) => child(node, step), content);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The texts whose value differs from the stored draft's at the same place, or is new. */
export function changedTexts(
  content: Readonly<Record<string, unknown>>,
  texts: readonly DraftText[],
  stored: Readonly<Record<string, unknown>> | null,
): DraftText[] {
  if (stored === null) return [...texts];
  return texts.filter((text) => !same(valueAt(content, text.path), valueAt(stored, text.path)));
}

/**
 * A copy of the draft in which each refused place keeps its last saved value, or has none when
 * nothing was saved there: a refused text is never written (design 6.1). The input is not
 * changed.
 */
export function restoreRefused(
  content: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>> | null,
  refused: readonly (readonly DraftStep[])[],
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  for (const path of refused) {
    const last = path[path.length - 1];
    if (last === undefined) continue;
    const parent = valueAt(copy, path.slice(0, -1));
    const before = stored === null ? undefined : valueAt(stored, path);
    if (typeof last !== 'string') continue; // a variant step is never the last one
    if (!isObject(parent)) continue;
    if (before === undefined) delete parent[last];
    else parent[last] = JSON.parse(JSON.stringify(before)) as unknown;
  }
  return copy;
}
