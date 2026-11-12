import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { RevisionContent } from './revision-content';

/** The version of the working-copy `content` shape a save writes (data design 3.6). */
export const WORKING_COPY_CONTENT_SCHEMA_VERSION = 1;

/** The largest serialised `content` a save accepts (UTF-8 bytes of its JSON). */
export const MAX_WORKING_COPY_CONTENT_BYTES = 256 * 1024;

/**
 * The editable draft of one product (catalog design 2.3 M-2): not a revision, one per product,
 * saved over the previous one. `content` is opaque JSON here; the schema that validates it is
 * the attribute schema of the product's family and arrives with the submit (slice 4c-4 and
 * later). `variantIds` are not stored in it: the variant registry of the product owns them.
 */
export interface WorkingCopy {
  readonly productId: Id<'Product'>;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentSchemaVersion: number;
  /** The published revision the draft was started from, or null for a never-published product. */
  readonly baseRevisionId: Id<'ProductRevision'> | null;
  readonly lastSavedAt: Temporal.Instant;
  readonly lastSavedByAccountId: Id<'Account'>;
}

/** A string PostgreSQL `jsonb` cannot store: a NUL character or an unpaired surrogate. */
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const unstorableText = (text: string): boolean =>
  text.includes('\u0000') || UNPAIRED_SURROGATE.test(text);

/**
 * A plain JSON object (not an array, not null) whose serialisation fits the
 * size cap and holds no key or string that `jsonb` refuses (U+0000, an unpaired surrogate): such
 * a payload would otherwise fail in the database as an unexpected fault. A value that does not
 * serialise (BigInt, a cycle) is refused. The caller passes the parsed request body, never an
 * object of its own making (a Date or a class instance is not a body).
 */
export function isStorableContent(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  let refused = false;
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (key, inner: unknown) => {
      if (unstorableText(key) || (typeof inner === 'string' && unstorableText(inner))) {
        refused = true;
      }
      return inner;
    });
  } catch {
    return false;
  }
  return (
    !refused &&
    json !== undefined &&
    Buffer.byteLength(json, 'utf8') <= MAX_WORKING_COPY_CONTENT_BYTES
  );
}

/**
 * The working-copy content a revision starts from (Add sizes creates a working copy from the
 * published revision when the product has none; catalog design 4.2a): the revision's texts,
 * categories, tax category, attribute values, photos and, per variant, its id, option values and
 * V4 fields, in the closed shape of the draft. Variant labels are the server's and stay out.
 * Nothing is shared with the revision: the result is a fresh object.
 */
export function workingContentOfRevision(content: RevisionContent): Record<string, unknown> {
  return {
    texts: Object.fromEntries(
      Object.entries(content.texts).map(([locale, text]) => [locale, { ...text }]),
    ),
    categoryIds: [...content.categoryIds],
    taxCategoryCode: content.taxCategoryCode,
    attributeValues: structuredClone(content.attributeValues),
    variants: content.variants.map((variant) => ({
      variantId: variant.variantId,
      optionValues: { ...variant.optionValues },
      gtin: variant.gtin,
      shippingWeightGrams: variant.shippingWeightGrams,
      shippingLengthMm: variant.shippingLengthMm,
      shippingWidthMm: variant.shippingWidthMm,
      shippingHeightMm: variant.shippingHeightMm,
      imageIds: [...variant.imageIds],
    })),
    imageIds: [...content.imageIds],
  };
}

/**
 * The content of a working copy once Add sizes has set the product's axes and the option values of
 * its one variant (catalog design 4.2a): `variantAxes` is replaced, and the entry of `variantId`
 * gets `optionValues` (an entry is added when the draft has none); every other key and entry is
 * kept as it was. The input is not modified.
 */
export function withSizes(
  content: Readonly<Record<string, unknown>>,
  input: {
    readonly variantId: Id<'Variant'>;
    readonly axes: readonly string[];
    readonly optionValues: Readonly<Record<string, string>>;
  },
): Record<string, unknown> {
  const existing = Array.isArray(content['variants']) ? (content['variants'] as unknown[]) : [];
  const entry = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const others = existing.filter((item) => !(entry(item) && item['variantId'] === input.variantId));
  const own = existing.find((item) => entry(item) && item['variantId'] === input.variantId);
  return {
    ...content,
    variantAxes: [...input.axes],
    variants: [
      ...others,
      {
        ...(entry(own) ? own : {}),
        variantId: input.variantId,
        optionValues: { ...input.optionValues },
      },
    ],
  };
}
