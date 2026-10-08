import { err } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type {
  ClaimTextCheckUnavailable,
  ClaimTextMatch,
  ClaimTextMatcher,
} from '../../application/ports/claim-text-matcher';

/**
 * Fail-closed stand-in for `certification.matchClaimTerms` (ADR-0031 decisions 1 and 2a). It is
 * a constant: every call answers unavailable, whatever the texts, the Market or the environment,
 * so every use case that writes a checked field refuses (`claim-text.check-unavailable`, design
 * 6.1, M8) and no claim text can be stored. The consumer's existing path that this triggers is
 * the per-field refusal of the working-copy save and the whole refusal of submit and check.
 * The binding PR replaces this class by the real facade and deletes it (decision 3); it must be
 * gone before the first sale (decision 4). No flag, config switch or branch may be added.
 */
export class UnavailableClaimTextMatcher implements ClaimTextMatcher {
  match(): Promise<Result<readonly (readonly ClaimTextMatch[])[], ClaimTextCheckUnavailable>> {
    return Promise.resolve(err({ code: 'claim-text.check-unavailable' }));
  }
}
