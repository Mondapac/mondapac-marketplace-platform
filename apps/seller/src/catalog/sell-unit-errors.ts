// The message key (under `catalog.variants-table.sell-units.error`) of a refused
// `own-offer.set-sell-units` call.
const BY_CODE: Readonly<Record<string, string>> = {
  'offer.sku-taken': 'sku-taken',
  'offer.none-selling': 'none-selling',
  'validation.failed': 'invalid',
  'conflict.stale': 'stale',
  'offer.not-found': 'not-found',
  'access.denied': 'denied',
  'seller.not-eligible': 'not-eligible',
  'request.csrf': 'csrf',
};

export function sellUnitProblemOf(code: string): string {
  return BY_CODE[code] ?? 'unknown';
}

/**
 * Where a refused `set-sell-units` call points and what to say. A field path is `units.<variantId>`
 * or `units.<index>[.field]` (the index counts the units that were sent); a path that names no sent
 * variant has no cell, so `variantId` is null and the message goes to the banner.
 */
export function sellUnitFailureOf(
  failure: {
    readonly code: string;
    readonly details?: { readonly fields?: readonly { path: string; code: string }[] };
  },
  sent: readonly string[],
): { readonly variantId: string | null; readonly problem: string } {
  const field = failure.details?.fields?.[0];
  if (failure.code !== 'validation.failed' || field === undefined) {
    return { variantId: null, problem: sellUnitProblemOf(failure.code) };
  }
  const problem = field.code === 'duplicate' ? 'duplicate' : 'invalid';
  const segment = /^units\.([^.]+)/.exec(field.path)?.[1];
  const variantId =
    segment === undefined
      ? null
      : /^\d+$/.test(segment)
        ? (sent[Number(segment)] ?? null)
        : (sent.find((id) => id === segment) ?? null);
  return { variantId, problem };
}
