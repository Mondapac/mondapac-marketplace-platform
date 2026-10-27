// The closed lists whose values are also CHECKs in the database (ordering data design O6, O6a):
// a `pnpm test:db` catalog test compares each list here with its CHECK, so a new code is a
// migration and a change here together.

/**
 * Who bears the loss of a refund (ordering domain design 3.5). `seller` (the default) has the
 * refund reversed in the seller ledger; `platform` leaves the seller's share whole (owner decision
 * Q-O2) and always says why, from Hadi's closed list.
 */
export const LOSS_BEARERS = ['seller', 'platform'] as const;
export type LossBearer = (typeof LOSS_BEARERS)[number];
export const LOSS_REASON_CODES = [
  'platform-error',
  'carrier-loss',
  'seller-unrecoverable',
  'fraud-loss',
  'goodwill',
  'other',
] as const;
export type LossReasonCode = (typeof LOSS_REASON_CODES)[number];
