import type { ApiFailure } from '../../api/client.ts';
import type { FormField } from './types.ts';

/** The variant attributes of the feature set a product may vary on. */
export function axisCandidates(fields: readonly FormField[]): readonly FormField[] {
  return fields.filter((field) => field.isVariantOption && field.dataType === 'select');
}

// The pure half of "Add sizes" and "Add a second type" (variants V9d; catalog design 4.2a).

/** The Market's cap on the options a product varies on, when the product read does not say. */
export const DEFAULT_MAX_AXES = 2;

/** `GET catalog/admin/platform-products/:id/add-sizes-impact`. */
export interface AddSizesImpact {
  readonly productId: string;
  readonly version: number;
  /** Offers of other sellers that go off sale: they may not sell products with sizes. */
  readonly offOfferCount: number;
}

/** `POST catalog/admin/platform-products/:id/add-sizes`. */
export interface AddSizesDone {
  readonly productId: string;
  readonly variantId: string;
  readonly version: number;
  readonly offOfferCount: number;
  readonly supersededRevisionId: string | null;
}

export interface AddSizesProblem {
  /** Key under `catalog.productForm.addSizes.error`. */
  readonly name: string;
  readonly values?: Record<string, string | number>;
  /** The refused axes or option values. */
  readonly issues: readonly { readonly path: string; readonly code: string }[];
  /** The page is stale: the admin should read the product again. */
  readonly reload: boolean;
  /** A revision is waiting and the admin has not yet agreed to set it aside. */
  readonly pendingExists: boolean;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'product.not-simple': 'not-simple',
  'revision.pending-exists': 'pending-exists',
  'product-type.not-allowed': 'type-not-allowed',
  'conflict.stale': 'stale',
  'confirm.count-changed': 'count-changed',
  'product.family-invalid': 'family-invalid',
  'product.not-editable': 'not-editable',
  'product.not-found': 'not-found',
  'access.unavailable': 'unavailable',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

const RELOAD = new Set(['not-simple', 'stale', 'not-editable', 'not-found']);

/** Issue codes the dialog explains in words; any other code is shown as `path: code`. */
export const KNOWN_ISSUES: ReadonlySet<string> = new Set([
  'variants.axes-none',
  'variants.axes-too-many',
  'variants.axes-duplicate',
  'variants.axes-unknown',
  'variants.axes-locked',
  'variants.option-missing',
  'variants.option-unknown',
  'variants.option-not-in-family',
  'variants.option-attribute-missing',
]);

export function addSizesProblemOf(failure: ApiFailure): AddSizesProblem {
  const issues = [...(failure.details?.fields ?? []), ...(failure.details?.issues ?? [])];
  const found = BY_CODE[failure.code];
  const name =
    found ??
    (failure.code === 'validation.failed'
      ? 'invalid'
      : failure.status === 503 || failure.status === 0
        ? 'unavailable'
        : 'unknown');
  const values: Record<string, string | number> = {};
  if (failure.details?.retryAfterSeconds !== undefined) {
    values['seconds'] = failure.details.retryAfterSeconds;
  }
  return {
    name,
    ...(Object.keys(values).length > 0 ? { values } : {}),
    issues,
    reload: RELOAD.has(name),
    pendingExists: name === 'pending-exists',
  };
}

/** The `currentCount` a `confirm.count-changed` answer carries, or null. */
export function currentCountOf(failure: ApiFailure): number | null {
  const count = failure.details?.currentCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** How many option types the Market lets a product vary on. */
export function maxAxesOf(max: number | undefined): number {
  return max === undefined || !Number.isSafeInteger(max) || max < 1 ? DEFAULT_MAX_AXES : max;
}

/**
 * "Add sizes" is offered on a Simple product that can still be changed and whose feature set has a
 * variant attribute to vary on.
 */
export function canAddSizes(
  product: { readonly variantModel: string; readonly status: string },
  fields: readonly FormField[],
): boolean {
  return (
    product.variantModel !== 'configurable' &&
    ['draft', 'published', 'unpublished', 'paused'].includes(product.status) &&
    axisCandidates(fields).length > 0
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The axes a published revision varies on, in feature set order; `null` for a Simple one.
 * The frozen content names `variantAxes`, else the variants' option keys tell.
 */
export function publishedAxesOf(
  content: Readonly<Record<string, unknown>> | undefined,
  fields: readonly FormField[],
): string[] | null {
  if (content === undefined) return null;
  const candidates = axisCandidates(fields).map((field) => field.code);
  const stored = content['variantAxes'];
  if (Array.isArray(stored)) {
    return candidates.filter((code) => stored.includes(code));
  }
  const variants = content['variants'];
  const used = new Set<string>();
  if (Array.isArray(variants)) {
    for (const entry of variants) {
      const options = isObject(entry) ? entry['optionValues'] : undefined;
      if (isObject(options)) for (const key of Object.keys(options)) used.add(key);
    }
  }
  return used.size === 0 ? null : candidates.filter((code) => used.has(code));
}

/**
 * The types a published product with one type may add as its second: every other variant
 * attribute of the feature set. Empty when the product has two types, or the Market allows one.
 */
export function secondAxisChoices(
  publishedAxes: readonly string[] | null,
  fields: readonly FormField[],
  maxAxes: number,
): FormField[] {
  if (publishedAxes === null || publishedAxes.length !== 1 || maxAxes < 2) return [];
  return axisCandidates(fields).filter((field) => !publishedAxes.includes(field.code));
}
