// Plain module (no 'use client'): server pages read it to decide whether to show the estimate.

/** The keys the estimate needs: the price view and the seller ledger (the commission is its data). */
export const RECEIVE_ESTIMATE_PERMISSIONS = [
  'pricing.price.view',
  'commission-payouts.earnings.view',
] as const;

/** True when the seller may see "You receive (est.)". */
export function canEstimateReceive(permissionKeys: readonly string[]): boolean {
  return RECEIVE_ESTIMATE_PERMISSIONS.every((key) => permissionKeys.includes(key));
}
