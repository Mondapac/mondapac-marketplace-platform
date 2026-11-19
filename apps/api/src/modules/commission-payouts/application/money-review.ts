import type { PayoutTermsOverride } from '../domain/payout-terms';

// Admin Inbox › System requests, area money: a seller's own commission rate and payout terms are
// changed at once and reviewed after (owner decision of 15 Nov 2026). A rejected or withdrawn
// change is restored by the reverters in money-reverters.ts.

/** The review area of commission-payouts' changes. */
export const MONEY_REVIEW_AREA = 'money';
/** A seller's own commission rate; values `{ rateBps: number | null }` (null = the Market rate). */
export const COMMISSION_RATE_SUBJECT_KIND = 'commission-payouts.commission-rate';
/** A seller's payout terms override; values `{ terms: TermsValues | null }` (null = none). */
export const PAYOUT_TERMS_SUBJECT_KIND = 'commission-payouts.payout-terms';

/** An override as plain JSON values (the HTTP body's form, which the parser reads back). */
export type TermsValues = {
  readonly weekdays: readonly string[] | null;
  readonly localTime: string | null;
  readonly holdDaysCarrier: number | null;
  readonly holdDaysSellerClick: number | null;
  readonly minimumMinor: number | null;
  readonly approvalMode: string | null;
};

export const termsValues = (override: PayoutTermsOverride): TermsValues => ({
  weekdays: override.weekdays === null ? null : [...override.weekdays],
  localTime: override.localTime,
  holdDaysCarrier: override.holdDaysCarrier,
  holdDaysSellerClick: override.holdDaysSellerClick,
  minimumMinor: override.minimumMinor === null ? null : Number(override.minimumMinor),
  approvalMode: override.approvalMode,
});
