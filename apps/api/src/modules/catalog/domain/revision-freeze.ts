import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { RevisionContent, RevisionText, RevisionVariantContent } from './revision-content';
import { MAX_TOPICS_PER_PRODUCT } from './topic';
import { normalizeGtin } from './variant-gtin';
import { isPositiveInt, VARIANT_FIELD_LIMITS } from './variant-fields';

/**
 * The freeze of a working copy into the content of a revision (catalog design 2.3 M-2, 4.2 row
 * 1; slice 4c-4): a pure function from the stored draft to the immutable content, or to the
 * list of places that are not ready. It checks shape and completeness that need no schema: the
 * Market's default locale has a name, at least one platform category, a tax category from the
 * Market list, the variants name live variants of the product. What needs the product's
 * attribute schema (the values, the option attributes) is checked by the service that has the
 * schema, before it calls the aggregate (slice 4c-5).
 */

/** Where the draft is not ready and why: a path and a code, never a value. */
export interface FreezeIssue {
  readonly path: string;
  readonly code: 'required' | 'invalid' | 'unknown' | 'duplicate' | 'too-many' | 'gtin.invalid';
}

export interface FreezeInput {
  /** The working copy's `content` (schema version 1). */
  readonly content: Readonly<Record<string, unknown>>;
  readonly defaultLocale: string;
  /** The Market's locales; a text in any other locale is refused. */
  readonly supportedLocales: readonly string[];
  /** The Market's tax category codes (`catalog.taxCategories`). */
  readonly taxCategoryCodes: readonly string[];
  /** `single`: the product's one variant, implicit in the draft; `options`: named by the draft. */
  readonly variantModel: 'single' | 'options';
  /** The live variants of the product (ids), in creation order. */
  readonly liveVariantIds: readonly Id<'Variant'>[];
  readonly maxVariants: number;
  /**
   * The automatic labels of a variant by its option values (V2). The draft never carries a label;
   * the caller builds them from the schema's option labels.
   */
  readonly labelsFor: (
    optionValues: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;
  readonly schemaRef: RevisionContent['schemaRef'];
  readonly contentSchemaVersion: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string';

const isNonBlank = (value: unknown): value is string => isText(value) && value.trim().length > 0;

/** `=` and `;` build the option key, so a code or value holding one could collide with another set (Hassan L4). */
const OPTION_SEPARATORS = /[=;]/;

const NO_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The canonical string of option values: codes sorted, `code=value` joined by `;`. */
export function optionKeyOf(optionValues: Readonly<Record<string, string>>): string {
  return Object.keys(optionValues)
    .sort()
    .map((code) => `${code}=${optionValues[code]}`)
    .join(';');
}

function parseTexts(
  raw: unknown,
  defaultLocale: string,
  supportedLocales: readonly string[],
  issues: FreezeIssue[],
): Record<string, RevisionText> {
  const texts: Record<string, RevisionText> = {};
  if (!isObject(raw)) {
    issues.push({ path: 'texts', code: 'required' });
    return texts;
  }
  for (const [locale, entry] of Object.entries(raw)) {
    // A key the seller typed is never echoed in a path until it matched the Market's list.
    if (!supportedLocales.includes(locale)) {
      if (!issues.some((issue) => issue.path === 'texts' && issue.code === 'unknown')) {
        issues.push({ path: 'texts', code: 'unknown' });
      }
      continue;
    }
    if (!isObject(entry)) {
      issues.push({ path: `texts.${locale}`, code: 'invalid' });
      continue;
    }
    const optional = (field: 'shortDescription' | 'description'): string | null => {
      const value = entry[field];
      if (value === undefined || value === null) return null;
      if (!isText(value)) {
        issues.push({ path: `texts.${locale}.${field}`, code: 'invalid' });
        return null;
      }
      return value.trim().length === 0 ? null : value;
    };
    const name = entry['name'];
    if (!isNonBlank(name)) {
      // The default locale's name is required; another locale may be left out entirely.
      if (locale === defaultLocale || name !== undefined) {
        issues.push({
          path: `texts.${locale}.name`,
          code: isText(name) || name === undefined ? 'required' : 'invalid',
        });
      }
      continue;
    }
    texts[locale] = {
      name,
      shortDescription: optional('shortDescription'),
      description: optional('description'),
    };
  }
  if (
    texts[defaultLocale] === undefined &&
    !issues.some((i) => i.path.startsWith(`texts.${defaultLocale}`))
  ) {
    issues.push({ path: `texts.${defaultLocale}.name`, code: 'required' });
  }
  return texts;
}

function parseIdList(raw: unknown, path: string, issues: FreezeIssue[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path, code: 'invalid' });
    return [];
  }
  const list: string[] = [];
  raw.forEach((item: unknown, index) => {
    if (!isNonBlank(item)) {
      issues.push({ path: `${path}.${index}`, code: 'invalid' });
    } else if (list.includes(item)) {
      issues.push({ path: `${path}.${index}`, code: 'duplicate' });
    } else {
      list.push(item);
    }
  });
  return list;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The topic ids of a draft (product tags T2): absent is none; a list of unique ids in the order
 * entered, at most `MAX_TOPICS_PER_PRODUCT`. A malformed value is `invalid` at `topicIds`, an item
 * that is not an id is `invalid` at `topicIds.<n>`, a repeat is `duplicate`. Whether a topic exists,
 * belongs to the Market and may be added is for the service that reads the topics.
 */
function parseTopicIds(raw: unknown, issues: FreezeIssue[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path: 'topicIds', code: 'invalid' });
    return [];
  }
  const list: string[] = [];
  raw.forEach((item: unknown, index) => {
    if (typeof item !== 'string' || !UUID.test(item)) {
      issues.push({ path: `topicIds.${index}`, code: 'invalid' });
    } else if (list.includes(item.toLowerCase())) {
      issues.push({ path: `topicIds.${index}`, code: 'duplicate' });
    } else {
      list.push(item.toLowerCase());
    }
  });
  if (raw.length > MAX_TOPICS_PER_PRODUCT) issues.push({ path: 'topicIds', code: 'too-many' });
  return list;
}

type VariantFields = Pick<
  RevisionVariantContent,
  | 'gtin'
  | 'shippingWeightGrams'
  | 'shippingLengthMm'
  | 'shippingWidthMm'
  | 'shippingHeightMm'
  | 'imageIds'
>;

/**
 * The V4 fields of one draft variant (GTIN, shipping, image picks). Every field is optional;
 * a refused one is listed by path and the variant keeps going so the seller sees all places at once.
 * `galleryIds` is the revision's image list: a pick outside it is `unknown`.
 */
function parseVariantFields(
  entry: Record<string, unknown>,
  path: string,
  galleryIds: readonly string[],
  issues: FreezeIssue[],
): VariantFields {
  const absent = (value: unknown): boolean => value === undefined || value === null;
  let gtin: string | null = null;
  const rawGtin = entry['gtin'];
  if (!absent(rawGtin)) {
    const parsed = typeof rawGtin === 'string' ? normalizeGtin(rawGtin) : null;
    if (parsed?.ok === true) gtin = parsed.value;
    else issues.push({ path: `${path}.gtin`, code: 'gtin.invalid' });
  }
  const size = (key: string, max: number): number | null => {
    const value = entry[key];
    if (absent(value)) return null;
    if (isPositiveInt(value, max)) return value;
    issues.push({ path: `${path}.${key}`, code: 'invalid' });
    return null;
  };
  const shippingWeightGrams = size('shippingWeightGrams', VARIANT_FIELD_LIMITS.weightGramsMax);
  const shippingLengthMm = size('shippingLengthMm', VARIANT_FIELD_LIMITS.dimensionMmMax);
  const shippingWidthMm = size('shippingWidthMm', VARIANT_FIELD_LIMITS.dimensionMmMax);
  const shippingHeightMm = size('shippingHeightMm', VARIANT_FIELD_LIMITS.dimensionMmMax);
  // A box has three sides: all three or none, so a carrier never reads a half-set size.
  const dims = [shippingLengthMm, shippingWidthMm, shippingHeightMm];
  if (dims.some((d) => d !== null) && dims.some((d) => d === null)) {
    for (const [key, d] of [
      ['shippingLengthMm', shippingLengthMm],
      ['shippingWidthMm', shippingWidthMm],
      ['shippingHeightMm', shippingHeightMm],
    ] as const) {
      if (d === null && absent(entry[key]))
        issues.push({ path: `${path}.${key}`, code: 'required' });
    }
  }
  const imageIds: string[] = [];
  const rawImages = entry['imageIds'];
  if (!absent(rawImages)) {
    if (!Array.isArray(rawImages) || rawImages.length > VARIANT_FIELD_LIMITS.imagesMax) {
      issues.push({
        path: `${path}.imageIds`,
        code: Array.isArray(rawImages) ? 'too-many' : 'invalid',
      });
    } else {
      rawImages.forEach((item: unknown, index) => {
        if (!isNonBlank(item)) issues.push({ path: `${path}.imageIds.${index}`, code: 'invalid' });
        else if (imageIds.includes(item)) {
          issues.push({ path: `${path}.imageIds.${index}`, code: 'duplicate' });
        } else if (!galleryIds.includes(item)) {
          issues.push({ path: `${path}.imageIds.${index}`, code: 'unknown' });
        } else imageIds.push(item);
      });
    }
  }
  return {
    gtin,
    shippingWeightGrams,
    shippingLengthMm,
    shippingWidthMm,
    shippingHeightMm,
    imageIds,
  };
}

function parseVariants(
  raw: unknown,
  input: FreezeInput,
  galleryIds: readonly string[],
  issues: FreezeIssue[],
): RevisionVariantContent[] {
  if (input.variantModel === 'single') {
    // The one variant is fixed by the product and carries no options (CC2: Simple has exactly one).
    // The draft may still carry its V4 fields, matched by the variant id.
    return input.liveVariantIds.slice(0, 1).map((variantId) => {
      const entry = Array.isArray(raw)
        ? (raw as unknown[]).find((item) => isObject(item) && item['variantId'] === variantId)
        : undefined;
      return {
        variantId,
        position: 1,
        optionKey: '',
        optionValues: {},
        labels: {},
        ...parseVariantFields(isObject(entry) ? entry : {}, 'variants.0', galleryIds, issues),
      };
    });
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ path: 'variants', code: 'required' });
    return [];
  }
  if (raw.length > input.maxVariants) {
    issues.push({ path: 'variants', code: 'too-many' });
    return [];
  }
  const variants: RevisionVariantContent[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  const gtins = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const path = `variants.${index}`;
    if (!isObject(entry)) {
      issues.push({ path, code: 'invalid' });
      return;
    }
    const variantId = entry['variantId'];
    if (!isNonBlank(variantId) || !input.liveVariantIds.includes(variantId as Id<'Variant'>)) {
      issues.push({ path: `${path}.variantId`, code: 'unknown' });
      return;
    }
    if (ids.has(variantId)) {
      issues.push({ path: `${path}.variantId`, code: 'duplicate' });
      return;
    }
    ids.add(variantId);
    const options = entry['optionValues'];
    const optionValues: Record<string, string> = {};
    if (!isObject(options) || Object.keys(options).length === 0) {
      issues.push({ path: `${path}.optionValues`, code: 'required' });
      return;
    }
    for (const [code, value] of Object.entries(options)) {
      if (
        NO_PROTOTYPE_KEYS.has(code) ||
        !isNonBlank(value) ||
        OPTION_SEPARATORS.test(code) ||
        OPTION_SEPARATORS.test(value)
      ) {
        issues.push({ path: `${path}.optionValues`, code: 'invalid' });
        return;
      }
      optionValues[code] = value;
    }
    const optionKey = optionKeyOf(optionValues);
    if (keys.has(optionKey)) {
      issues.push({ path: `${path}.optionValues`, code: 'duplicate' });
      return;
    }
    keys.add(optionKey);
    const fields = parseVariantFields(entry, path, galleryIds, issues);
    // One product never carries a GTIN twice: it names one item (V4).
    if (fields.gtin !== null) {
      if (gtins.has(fields.gtin)) issues.push({ path: `${path}.gtin`, code: 'duplicate' });
      gtins.add(fields.gtin);
    }
    variants.push({
      variantId,
      position: variants.length + 1,
      optionKey,
      optionValues,
      labels: { ...input.labelsFor(optionValues) },
      ...fields,
    });
  });
  return variants;
}

/** Freezes a working copy into revision content, or lists every place it is not ready. */
export function freezeWorkingCopy(
  input: FreezeInput,
): Result<RevisionContent, readonly FreezeIssue[]> {
  const issues: FreezeIssue[] = [];
  const { content } = input;
  const texts = parseTexts(content['texts'], input.defaultLocale, input.supportedLocales, issues);
  const categoryIds = parseIdList(content['categoryIds'], 'categoryIds', issues);
  if (categoryIds.length === 0 && !issues.some((issue) => issue.path.startsWith('categoryIds'))) {
    issues.push({ path: 'categoryIds', code: 'required' });
  }
  const topicIds = parseTopicIds(content['topicIds'], issues);
  const tax = content['taxCategoryCode'];
  if (!isNonBlank(tax)) {
    issues.push({ path: 'taxCategoryCode', code: 'required' });
  } else if (!input.taxCategoryCodes.includes(tax)) {
    issues.push({ path: 'taxCategoryCode', code: 'unknown' });
  }
  const attributeValues = content['attributeValues'] ?? {};
  if (!isObject(attributeValues)) issues.push({ path: 'attributeValues', code: 'invalid' });
  const imageIds = parseIdList(content['imageIds'], 'imageIds', issues);
  const variants = parseVariants(content['variants'], input, imageIds, issues);
  if (issues.length > 0) return err(issues);
  return ok({
    texts,
    categoryIds,
    topicIds,
    taxCategoryCode: tax as string,
    attributeValues: attributeValues as Record<string, unknown>,
    variants,
    imageIds,
    schemaRef: input.schemaRef,
    contentSchemaVersion: input.contentSchemaVersion,
  });
}

/**
 * The content of a tax category override (catalog design 4.3; AC 36, Hassan 1a): the published
 * revision's content with only the tax category changed. It takes the published content as its
 * only source, so a pending seller revision or the working copy can never leak into it. The new
 * code must be one of the Market's.
 */
export function buildTaxOverrideContent(
  published: RevisionContent,
  taxCategoryCode: string,
  taxCategoryCodes: readonly string[],
): Result<RevisionContent, { readonly code: 'tax-category.unknown' | 'tax-category.unchanged' }> {
  if (!taxCategoryCodes.includes(taxCategoryCode)) return err({ code: 'tax-category.unknown' });
  if (published.taxCategoryCode === taxCategoryCode) return err({ code: 'tax-category.unchanged' });
  return ok({ ...published, taxCategoryCode });
}

/**
 * The content of a category override (categories package C5a, decision 8): the published
 * revision's content with category `from` replaced by `to`. It takes the published content as its
 * only source, as the tax override does. `to` must already be a valid product category (the caller
 * checked level and status). If `to` is already on the revision it is inserted once (`from` is
 * dropped); if `from` was the primary (first), `to` becomes the primary. The list never grows, so
 * the limit of three holds.
 */
export function buildCategoryOverrideContent(
  published: RevisionContent,
  from: string,
  to: string,
): Result<RevisionContent, { readonly code: 'category.unchanged' }> {
  const ids = published.categoryIds;
  if (from === to || !ids.includes(from)) return err({ code: 'category.unchanged' });
  const wasPrimary = ids[0] === from;
  const replaced = ids.map((id) => (id === from ? to : id));
  let categoryIds = replaced.filter((id, index) => replaced.indexOf(id) === index);
  if (wasPrimary) categoryIds = [to, ...categoryIds.filter((id) => id !== to)];
  return ok({ ...published, categoryIds });
}
