import { ok } from '@mondapac/shared-kernel';
import type { ClaimTextMatcher } from '../../src/modules/catalog/application/ports/claim-text-matcher';

/** A matcher that finds no claim term in any text. Tests only: it is permissive by design. */
export const cleanClaimTextMatcher: ClaimTextMatcher = {
  match: (_context, texts) => Promise.resolve(ok(texts.map(() => []))),
};
