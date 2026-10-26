import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The short customer names ("Maryam R.") of review authors, read at read time and never stored
 * (owner decision N10). An account without a name, or one the source cannot answer for, is
 * absent from the map and its review is shown as "Verified buyer". PERSONAL DATA: never logged,
 * cached or put in an event; rendered as escaped text only.
 */
export interface ReviewerNames {
  shortNames(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, string>>;
}

export const REVIEWER_NAMES = Symbol('REVIEWER_NAMES');
