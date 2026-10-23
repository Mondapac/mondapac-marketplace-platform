import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * What the request says about the shopper's privacy and identity, besides the caller's context:
 * `Sec-GPC: 1`, the guest's `Engagement-Consent: granted` and the raw engagement guest cookie
 * token. Never logged, never copied into an answer.
 */
export interface PrivacySignals {
  readonly globalPrivacyControl: boolean;
  readonly consent: boolean;
  readonly guestToken: string | null;
}

/** The ids a shopper recently viewed: distinct, newest first, at most 50 of each. */
export interface PersonalViews {
  readonly productIds: readonly Id<'Product'>[];
  readonly categoryIds: readonly Id<'Category'>[];
}

/**
 * Where the personal recommendations get their input (personalization package 1d-1): the
 * shopper's recent views from `engagement` (already empty under Global Privacy Control, with the
 * customer's switch off, or for a guest without consent) and the categories that certification
 * marks, which are never a signal. Every method is `null` when the source refused or failed.
 */
export interface PersonalSignals {
  recentViews(context: CallContext, privacy: PrivacySignals): Promise<PersonalViews | null>;
  /** Categories that a claim policy of certification names; never used as a signal. */
  certifiedCategoryIds(context: CallContext): Promise<ReadonlySet<Id<'Category'>> | null>;
}

export const PERSONAL_SIGNALS = Symbol('PERSONAL_SIGNALS');
