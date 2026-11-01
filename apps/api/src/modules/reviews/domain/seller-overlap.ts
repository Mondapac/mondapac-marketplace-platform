// Fraud signals of package 5: does a buyer look like the seller they review? Two comparisons,
// both pure, both only ever RAISE A SIGNAL (a code on a review or rating); they never refuse a
// review. The facts come from a port; nothing compared here is stored or logged, only the code.

export const OVERLAP_SIGNAL_CODES = ['same-address-as-seller', 'same-payment-fingerprint'] as const;
export type OverlapSignalCode = (typeof OVERLAP_SIGNAL_CODES)[number];

/** An address as the Market's `address.format` names its fields (key to value). */
export type AddressFields = Readonly<Record<string, string>>;

/**
 * What the port knows about one buyer and one seller. Everything is optional knowledge: an empty
 * list or a null address means the source could not say, which raises no signal.
 */
export interface OverlapFacts {
  /** Where the buyer's order was delivered, or null when it was collected or is unknown. */
  readonly deliveryAddress: AddressFields | null;
  /** The seller's operating address and, when different, its registered address. */
  readonly sellerAddresses: readonly AddressFields[];
  /** Opaque payment-method fingerprints the buyer paid this order with. */
  readonly buyerPaymentFingerprints: readonly string[];
  /** Opaque fingerprints of the seller's own payment methods. */
  readonly sellerPaymentFingerprints: readonly string[];
}

/** How many fields two addresses must share (non-empty on both sides) before they can match. */
export const MIN_SHARED_ADDRESS_FIELDS = 2;

/** Folds case and compatibility forms, drops punctuation and collapses white space. */
export function normaliseAddressValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Whether two addresses are the same place: at least {@link MIN_SHARED_ADDRESS_FIELDS} fields are
 * non-empty on both sides, and every such field is equal once folded. A single shared field (a
 * postcode, a suburb) is never enough, and one differing field (another unit number) is not a
 * match.
 */
export function sameAddress(a: AddressFields, b: AddressFields): boolean {
  let shared = 0;
  for (const [key, rawA] of Object.entries(a)) {
    const rawB = b[key];
    if (rawB === undefined) continue;
    const valueA = normaliseAddressValue(rawA);
    const valueB = normaliseAddressValue(rawB);
    if (valueA === '' || valueB === '') continue;
    if (valueA !== valueB) return false;
    shared += 1;
  }
  return shared >= MIN_SHARED_ADDRESS_FIELDS;
}

/** The signal codes the facts raise, in a fixed order, each at most once. */
export function overlapSignals(facts: OverlapFacts): readonly OverlapSignalCode[] {
  const codes: OverlapSignalCode[] = [];
  const delivery = facts.deliveryAddress;
  if (
    delivery !== null &&
    facts.sellerAddresses.some((address) => sameAddress(delivery, address))
  ) {
    codes.push('same-address-as-seller');
  }
  const sellerPrints = new Set(
    facts.sellerPaymentFingerprints.map((print) => print.trim()).filter((print) => print !== ''),
  );
  if (
    facts.buyerPaymentFingerprints.some((print) => {
      const trimmed = print.trim();
      return trimmed !== '' && sellerPrints.has(trimmed);
    })
  ) {
    codes.push('same-payment-fingerprint');
  }
  return codes;
}
