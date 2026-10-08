import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { RevisionContent, RevisionText, RevisionVariantContent } from './revision-content';

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
  readonly code: 'required' | 'invalid' | 'unknown' | 'duplicate' | 'too-many';
}

export interface FreezeInput {
  /** The working copy's `content` (schema version 1). */
  readonly content: Readonly<Record<string, unknown>>;
  readonly defaultLocale: string;
  /** The Market's tax category codes (`catalog.taxCategories`). */
  readonly taxCategoryCodes: readonly string[];
  /** `single`: the product's one variant, implicit in the draft; `options`: named by the draft. */
  readonly variantModel: 'single' | 'options';
  /** The live variants of the product (ids), in creation order. */
  readonly liveVariantIds: readonly Id<'Variant'>[];
  readonly maxVariants: number;
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
  issues: FreezeIssue[],
): Record<string, RevisionText> {
  const texts: Record<string, RevisionText> = {};
  if (!isObject(raw)) {
    issues.push({ path: 'texts', code: 'required' });
    return texts;
  }
  for (const [locale, entry] of Object.entries(raw)) {
    if (NO_PROTOTYPE_KEYS.has(locale)) {
      issues.push({ path: `texts.${locale}`, code: 'invalid' });
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

function parseVariants(
  raw: unknown,
  input: FreezeInput,
  issues: FreezeIssue[],
): RevisionVariantContent[] {
  if (input.variantModel === 'single') {
    // The one variant is fixed by the product and carries no options (CC2: Simple has exactly one).
    return input.liveVariantIds.slice(0, 1).map((variantId) => ({
      variantId,
      position: 1,
      optionKey: '',
      optionValues: {},
      labels: {},
    }));
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
        issues.push({ path: `${path}.optionValues.${code}`, code: 'invalid' });
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
    const labels: Record<string, string> = {};
    const rawLabels = entry['labels'];
    if (rawLabels !== undefined) {
      if (!isObject(rawLabels)) {
        issues.push({ path: `${path}.labels`, code: 'invalid' });
        return;
      }
      for (const [locale, label] of Object.entries(rawLabels)) {
        if (NO_PROTOTYPE_KEYS.has(locale) || !isNonBlank(label)) {
          issues.push({ path: `${path}.labels.${locale}`, code: 'invalid' });
          return;
        }
        labels[locale] = label;
      }
    }
    variants.push({
      variantId,
      position: variants.length + 1,
      optionKey,
      optionValues,
      labels,
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
  const texts = parseTexts(content['texts'], input.defaultLocale, issues);
  const categoryIds = parseIdList(content['categoryIds'], 'categoryIds', issues);
  if (categoryIds.length === 0 && !issues.some((issue) => issue.path.startsWith('categoryIds'))) {
    issues.push({ path: 'categoryIds', code: 'required' });
  }
  const tax = content['taxCategoryCode'];
  if (!isNonBlank(tax)) {
    issues.push({ path: 'taxCategoryCode', code: 'required' });
  } else if (!input.taxCategoryCodes.includes(tax)) {
    issues.push({ path: 'taxCategoryCode', code: 'unknown' });
  }
  const attributeValues = content['attributeValues'] ?? {};
  if (!isObject(attributeValues)) issues.push({ path: 'attributeValues', code: 'invalid' });
  const imageIds = parseIdList(content['imageIds'], 'imageIds', issues);
  const variants = parseVariants(content['variants'], input, issues);
  if (issues.length > 0) return err(issues);
  return ok({
    texts,
    categoryIds,
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
