import { err } from '@mondapac/shared-kernel';
import type { ClaimTextMatcher } from '../../src/modules/catalog/application/ports/claim-text-matcher';

/** A matcher whose every check is unavailable: the fail-closed path of design 6.1, for tests. */
export const unavailableClaimTextMatcher: ClaimTextMatcher = {
  match: () => Promise.resolve(err({ code: 'claim-text.check-unavailable' } as const)),
};
