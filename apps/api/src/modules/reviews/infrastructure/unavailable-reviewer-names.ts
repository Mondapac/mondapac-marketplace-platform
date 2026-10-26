import type { Id } from '@mondapac/shared-kernel';
import type { ReviewerNames } from '../application/ports/reviewer-names';

/**
 * The reviewer name source until identity (or ordering) offers a public-safe short name: it
 * knows no name, so every non-anonymous review is shown as "Verified buyer" (the safe fallback;
 * never a wrong name). The existing `customerShortNames` of identity is for a seller's own
 * orders and refuses every other caller, so it cannot serve a public page. Swap this binding
 * (REVIEWER_NAMES in the module) when the owner decides where the short name comes from; see
 * docs/modules/reviews/notes.md, open question 1.
 */
export class UnavailableReviewerNames implements ReviewerNames {
  shortNames(): Promise<ReadonlyMap<Id<'Account'>, string>> {
    return Promise.resolve(new Map());
  }
}
