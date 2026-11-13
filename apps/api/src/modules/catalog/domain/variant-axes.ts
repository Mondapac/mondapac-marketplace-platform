import type { AttributeSchema } from '@mondapac/shared-kernel';

/** Where and why the axes a draft names are refused. Codes only. */
export type AxisIssue = {
  readonly path: string;
  readonly code:
    | 'variants.axes-unknown'
    | 'variants.axes-duplicate'
    | 'variants.axes-none'
    | 'variants.axes-too-many'
    | 'variants.axes-locked';
};

export type AxesResult =
  | { readonly ok: true; readonly schema: AttributeSchema; readonly codes: readonly string[] }
  | { readonly ok: false; readonly issues: readonly AxisIssue[] };

/** The option attributes of the family a product may vary on: its Single choice variant attributes. */
export function axisCandidates(schema: AttributeSchema): readonly string[] {
  return schema.fields
    .filter((field) => field.isVariantOption && field.dataType === 'select')
    .map((field) => field.code);
}

/**
 * The axes a configurable product varies on (variants V3, decision t12): the variant attributes of
 * its feature set that the working copy's `variantAxes` names, in the feature set's order. A draft
 * without `variantAxes` varies on all of them, as before. At most `maxAxes` (Market configuration
 * `maxVariantAttributes`), each once, each a candidate of the feature set. `lockedTo` is the axes of
 * the published revision: once a product is published its axes stay as they were (decision t3), so
 * a different set is refused, with one exception (Add a second axis, V9b): when the published
 * revision has exactly one axis and `maxAxes` is at least 2, that axis plus exactly one more is
 * accepted, once (with at most two axes nothing is stored for it). The returned schema holds the chosen
 * axes as the only option attributes; an unchosen candidate is not an axis of this product.
 */
export function chooseAxes(
  schema: AttributeSchema,
  requested: readonly string[] | undefined,
  maxAxes: number,
  lockedTo: readonly string[] | null,
): AxesResult {
  const candidates = axisCandidates(schema);
  const issues: AxisIssue[] = [];
  // No request: a published product keeps its axes, a new one varies on every candidate.
  const asked = requested ?? lockedTo ?? candidates;
  if (requested !== undefined && requested.length === 0) {
    issues.push({ path: 'variantAxes', code: 'variants.axes-none' });
  }
  if (new Set(asked).size !== asked.length) {
    issues.push({ path: 'variantAxes', code: 'variants.axes-duplicate' });
  }
  if (asked.some((code) => !candidates.includes(code))) {
    issues.push({ path: 'variantAxes', code: 'variants.axes-unknown' });
  }
  if (asked.length > maxAxes) issues.push({ path: 'variantAxes', code: 'variants.axes-too-many' });
  const codes = candidates.filter((code) => asked.includes(code));
  const sameAxes =
    lockedTo !== null &&
    codes.length === lockedTo.length &&
    codes.every((code) => lockedTo.includes(code));
  // One locked axis plus exactly one more: the single 1 -> 2 step.
  const secondAxis =
    lockedTo !== null &&
    lockedTo.length === 1 &&
    maxAxes >= 2 &&
    codes.length === 2 &&
    lockedTo.every((code) => codes.includes(code));
  if (lockedTo !== null && !sameAxes && !secondAxis) {
    issues.push({ path: 'variantAxes', code: 'variants.axes-locked' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    codes,
    schema: {
      ...schema,
      fields: schema.fields.filter(
        (field) =>
          !(field.isVariantOption && field.dataType === 'select') || codes.includes(field.code),
      ),
    },
  };
}
