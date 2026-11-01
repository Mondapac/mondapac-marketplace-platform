// Fraud signals of package 5: does a buyer look like the seller they review? Two yes or no
// answers from the modules that own the data (ordering for the address, payments for the payment
// fingerprint). They only ever RAISE A SIGNAL (a code on a review or rating); they never refuse a
// review. Reviews never sees an address or a payment detail: the comparison is made where the data
// lives and only the two answers cross the facade. Only the code is stored.

export const OVERLAP_SIGNAL_CODES = ['same-address-as-seller', 'same-payment-fingerprint'] as const;
export type OverlapSignalCode = (typeof OVERLAP_SIGNAL_CODES)[number];

/**
 * What the owners say about one buyer and one seller order. `null` means that owner could not say
 * (collected order, unknown), which raises no signal; `false` is a real "no".
 */
export interface OverlapAnswers {
  readonly sameAddress: boolean | null;
  readonly samePaymentFingerprint: boolean | null;
}

/** The signal codes the answers raise, in a fixed order, each at most once. */
export function overlapSignals(answers: OverlapAnswers): readonly OverlapSignalCode[] {
  const codes: OverlapSignalCode[] = [];
  if (answers.sameAddress === true) codes.push('same-address-as-seller');
  if (answers.samePaymentFingerprint === true) codes.push('same-payment-fingerprint');
  return codes;
}
