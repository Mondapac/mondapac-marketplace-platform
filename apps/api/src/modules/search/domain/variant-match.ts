import type { Id, Money } from '@mondapac/shared-kernel';
import type { OfferVariantDocument } from './offer-document';
import type { PriceRange } from './search-filter';

/** What a result shows of its sell units (variants V8). */
export interface VariantMatch {
  /**
   * The variant the product page opens on (`?v=`): the first matching unit by the owner's order,
   * when a variant filter or the price filter narrowed the list; null otherwise (the page picks its
   * own default, the first in-stock variant).
   */
  readonly variantId: Id<'Variant'> | null;
  /**
   * The lowest buyer price of the matching units (all in-stock units when nothing narrowed to a
   * unit), and whether they differ ("From $X"). Null when no such unit is in stock and priced.
   */
  readonly price: { readonly from: Money; readonly varies: boolean } | null;
}

const inRange = (amount: bigint, range: PriceRange | null): boolean =>
  range === null ||
  ((range.min === null || amount >= range.min) && (range.max === null || amount <= range.max));

/**
 * The matching variant and the "From" price of one result (pure). A unit counts only when it is in
 * stock and priced. `groups` are the facet strings of each choice filter (one of each must be held,
 * by the document or the unit); when the document alone holds every group and no price is asked,
 * nothing narrowed to a unit. Same rule as the filtered query, so a shown result always has its unit.
 */
export function matchVariants(input: {
  readonly facetCodes: readonly string[];
  readonly variants: readonly OfferVariantDocument[];
  readonly groups: readonly (readonly string[])[];
  readonly price: PriceRange | null;
}): VariantMatch {
  const own = new Set(input.facetCodes);
  const groups = input.groups.filter((group) => group.length > 0);
  const narrowed =
    input.price !== null || groups.some((group) => !group.some((facet) => own.has(facet)));
  const eligible = [...input.variants]
    .filter((unit) => unit.inStock && unit.price !== null)
    .sort((a, b) => a.position - b.position || (a.variantId < b.variantId ? -1 : 1));
  const matching = narrowed
    ? eligible.filter((unit) => {
        const held = new Set(unit.facetCodes);
        return (
          groups.every((group) => group.some((facet) => own.has(facet) || held.has(facet))) &&
          inRange(unit.price!.amount, input.price)
        );
      })
    : eligible;
  const first = matching[0];
  if (first === undefined) return { variantId: null, price: null };
  const currency = first.price!.currency;
  const amounts = matching
    .filter((unit) => unit.price!.currency === currency)
    .map((unit) => unit.price!.amount);
  const lowest = amounts.reduce((low, amount) => (amount < low ? amount : low));
  return {
    variantId: narrowed ? first.variantId : null,
    price: {
      from: { amount: lowest, currency },
      varies: amounts.some((amount) => amount !== lowest),
    },
  };
}

/**
 * The 14-digit form of a search text that is exactly one GTIN (GTIN-8, 12, 13 or 14 with a valid
 * GS1 check digit; spaces and hyphens ignored), or null (pure). Search keeps its own copy of
 * catalog's rule: it never imports catalog's code.
 */
export function gtinOfQuery(text: string): string | null {
  const digits = text.trim().replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return null;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const weight = (body.length - index) % 2 === 1 ? 3 : 1;
    sum += Number(body[index]) * weight;
  }
  if ((10 - (sum % 10)) % 10 !== Number(digits.at(-1))) return null;
  return digits.padStart(14, '0');
}
