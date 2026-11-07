import type { RevisionContent } from '../revision-content';
import type { SellerGroupPlan, SellerVariantPlan } from './row-check';

// How a checked group of the seller import is laid over the product's draft (catalog design 14c,
// "An update"): the file's non-empty cells replace the stored values, an empty cell keeps them, the
// variants already on the product stay in their order and a new option combination is appended.
// Pure functions over plain data; the row use case saves the result through the draft save.

type Draft = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The base a group is merged into: the stored draft (or the published revision as a draft). */
export interface MergeBase {
  readonly content: Readonly<Record<string, unknown>>;
  /** The product's live variants in registry order. */
  readonly liveVariantIds: readonly string[];
}

export interface MergeEnvironment {
  readonly defaultLocale: string;
}

export interface MergedRow {
  readonly content: Draft;
  /** The registry list for the save: the live ids in order, then `null` for each new variant. */
  readonly variantIds: readonly (string | null)[];
  /** The placeholder variant ids written for the new variants, in the order of the nulls. */
  readonly placeholders: readonly string[];
  /** True when the merged draft differs from the base (or a variant is new). */
  readonly changed: boolean;
}

/** The id a new variant carries in the draft until the save mints its real one. */
export function placeholderOf(rowNumber: number): string {
  return `new-${rowNumber}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stable).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function optionKeyOfValues(values: Readonly<Record<string, unknown>>): string {
  return Object.keys(values)
    .sort()
    .map((code) => `${code}=${String(values[code])}`)
    .join(';');
}

function mergeVariantFields(variant: Draft, plan: SellerVariantPlan): Draft {
  const next: Draft = { ...variant };
  if (plan.gtin !== null) next['gtin'] = plan.gtin;
  if (plan.shippingWeightGrams !== null) next['shippingWeightGrams'] = plan.shippingWeightGrams;
  if (plan.shippingLengthMm !== null) next['shippingLengthMm'] = plan.shippingLengthMm;
  if (plan.shippingWidthMm !== null) next['shippingWidthMm'] = plan.shippingWidthMm;
  if (plan.shippingHeightMm !== null) next['shippingHeightMm'] = plan.shippingHeightMm;
  return next;
}

/**
 * Lays the product part of a `my-products` plan and its variants over the base draft. A plan for
 * `sell-from-catalogue` has no product part and is not merged.
 */
export function mergeImportRow(
  base: MergeBase,
  plan: SellerGroupPlan,
  env: MergeEnvironment,
): MergedRow {
  const content: Draft = structuredClone(base.content);
  const patch = plan.product;
  if (patch !== null) {
    const texts: Draft = isObject(content['texts']) ? { ...content['texts'] } : {};
    const current = isObject(texts[env.defaultLocale])
      ? { ...(texts[env.defaultLocale] as Draft) }
      : {};
    if (patch.title !== null) current['name'] = patch.title;
    if (patch.shortDescription !== null) current['shortDescription'] = patch.shortDescription;
    if (patch.description !== null) current['description'] = patch.description;
    if (Object.keys(current).length > 0) texts[env.defaultLocale] = current;
    if (Object.keys(texts).length > 0) content['texts'] = texts;

    if (patch.categoryId !== null) {
      const rest = Array.isArray(content['categoryIds'])
        ? (content['categoryIds'] as string[]).filter((id) => id !== patch.categoryId)
        : [];
      content['categoryIds'] = [patch.categoryId, ...rest];
    }
    if (patch.taxCategoryCode !== null) content['taxCategoryCode'] = patch.taxCategoryCode;
    if (Object.keys(patch.attributeValues).length > 0) {
      content['attributeValues'] = {
        ...(isObject(content['attributeValues']) ? content['attributeValues'] : {}),
        ...patch.attributeValues,
      };
    }
    const hasAxes = Array.isArray(content['variantAxes']) && content['variantAxes'].length > 0;
    if (!hasAxes && patch.axes.length > 0) content['variantAxes'] = [...patch.axes];
    if (!Array.isArray(content['imageIds'])) content['imageIds'] = [];
  }

  const variants: Draft[] = Array.isArray(content['variants'])
    ? (content['variants'] as unknown[]).filter(isObject).map((variant) => ({ ...variant }))
    : [];
  const variantIds: (string | null)[] = [...base.liveVariantIds];
  const placeholders: string[] = [];
  const byKey = new Map<string, string>();
  for (const variant of variants) {
    const id = variant['variantId'];
    const options = isObject(variant['optionValues']) ? variant['optionValues'] : {};
    if (typeof id === 'string') byKey.set(optionKeyOfValues(options), id);
  }
  for (const live of base.liveVariantIds) {
    if (!variants.some((variant) => variant['variantId'] === live)) {
      variants.push({ variantId: live });
    }
  }
  const single = base.liveVariantIds.length === 1 ? (base.liveVariantIds[0] ?? null) : null;

  for (const row of plan.variants) {
    let targetId = row.existingVariantId;
    if (targetId === null && row.optionKey === '' && single !== null) targetId = single;
    if (targetId === null) targetId = byKey.get(row.optionKey) ?? null;
    const at = targetId === null ? -1 : variants.findIndex((v) => v['variantId'] === targetId);
    if (at >= 0) {
      variants[at] = mergeVariantFields(variants[at] as Draft, row);
      continue;
    }
    const placeholder = placeholderOf(row.rowNumber);
    placeholders.push(placeholder);
    variantIds.push(null);
    variants.push(
      mergeVariantFields({ variantId: placeholder, optionValues: { ...row.optionValues } }, row),
    );
  }
  if (variants.length > 0) content['variants'] = variants;

  const changed = placeholders.length > 0 || stable(content) !== stable(base.content);
  return { content, variantIds, placeholders, changed };
}

/** The draft with each placeholder variant id replaced by the id the save minted for it. */
export function withMintedIds(
  content: Readonly<Record<string, unknown>>,
  placeholders: readonly string[],
  minted: readonly string[],
): Draft {
  const map = new Map<string, string>();
  placeholders.forEach((placeholder, index) => {
    const id = minted[index];
    if (id !== undefined) map.set(placeholder, id);
  });
  const next: Draft = { ...content };
  if (Array.isArray(next['variants'])) {
    next['variants'] = (next['variants'] as unknown[]).map((variant) => {
      if (!isObject(variant)) return variant;
      const id = variant['variantId'];
      const replacement = typeof id === 'string' ? map.get(id) : undefined;
      return replacement === undefined ? variant : { ...variant, variantId: replacement };
    });
  }
  return next;
}

/**
 * A published revision as the draft shape a save takes: what an update of a product that has no
 * working copy starts from. Labels are built by the server and never part of a draft.
 */
export function draftContentOfRevision(revision: RevisionContent): Draft {
  const texts: Draft = {};
  for (const [locale, text] of Object.entries(revision.texts)) {
    const entry: Draft = { name: text.name };
    if (text.shortDescription !== null) entry['shortDescription'] = text.shortDescription;
    if (text.description !== null) entry['description'] = text.description;
    texts[locale] = entry;
  }
  const axes = new Set<string>();
  const variants = revision.variants.map((variant) => {
    for (const code of Object.keys(variant.optionValues)) axes.add(code);
    const out: Draft = { variantId: variant.variantId };
    if (Object.keys(variant.optionValues).length > 0) {
      out['optionValues'] = { ...variant.optionValues };
    }
    if (variant.gtin !== null) out['gtin'] = variant.gtin;
    if (variant.shippingWeightGrams !== null)
      out['shippingWeightGrams'] = variant.shippingWeightGrams;
    if (variant.shippingLengthMm !== null) out['shippingLengthMm'] = variant.shippingLengthMm;
    if (variant.shippingWidthMm !== null) out['shippingWidthMm'] = variant.shippingWidthMm;
    if (variant.shippingHeightMm !== null) out['shippingHeightMm'] = variant.shippingHeightMm;
    if (variant.imageIds.length > 0) out['imageIds'] = [...variant.imageIds];
    return out;
  });
  const draft: Draft = {
    texts,
    categoryIds: [...revision.categoryIds],
    taxCategoryCode: revision.taxCategoryCode,
    attributeValues: structuredClone(revision.attributeValues),
    imageIds: [...revision.imageIds],
    variants,
  };
  if (axes.size > 0) draft['variantAxes'] = [...axes];
  return draft;
}
