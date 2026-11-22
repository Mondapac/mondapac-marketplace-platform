import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type { ClaimTextToMatch } from '../application/ports/claim-text-matcher';
import type {
  CandidateMatchFailure,
  CandidateTerms,
  ClaimTermsCandidateMatcher,
} from '../application/ports/claim-terms-candidate-matcher';

const UNAVAILABLE = err({ code: 'claim-text.check-unavailable' } as const);

/**
 * `ClaimTermsCandidateMatcher` over `certification.matchCandidateClaimTerms` (request X-1). The
 * caller's `CallContext` goes through unchanged. A refusal of the candidate terms is passed on as
 * `validation.failed` (field paths and codes only); an access refusal as `access.denied`; any
 * other refusal, fault or malformed answer is unavailable, never zero. Only a yes or no per text
 * is kept; the facade holds no unit open for the caller.
 */
export class CertificationClaimTermsCandidateMatcher implements ClaimTermsCandidateMatcher {
  readonly #logger = new Logger('CertificationClaimTermsCandidateMatcher');

  constructor(private readonly certification: CertificationFacade) {}

  async matches(
    context: CallContext,
    candidate: CandidateTerms,
    texts: readonly ClaimTextToMatch[],
  ): Promise<Result<readonly boolean[], CandidateMatchFailure>> {
    let answer: Awaited<ReturnType<CertificationFacade['matchCandidateClaimTerms']>>;
    try {
      answer = await this.certification.matchCandidateClaimTerms(
        context,
        candidate,
        texts.map(({ locale, text }) => ({ locale, text })),
      );
    } catch (error) {
      this.#logger.warn({
        msg: 'catalog.claim-terms.certification-failed',
        reason: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    }
    if (!answer.ok) {
      this.#logger.warn({
        msg: 'catalog.claim-terms.certification-refused',
        code: answer.error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      if (answer.error.code === 'access.denied') return err({ code: 'access.denied' });
      if (answer.error.code === 'validation.failed') {
        return err({
          code: 'validation.failed',
          fields: answer.error.fields.map(({ path, code }) => ({ path, code })),
        });
      }
      return UNAVAILABLE;
    }
    const value: unknown = answer.value;
    if (
      !Array.isArray(value) ||
      value.length !== texts.length ||
      !value.every((matches: unknown) => Array.isArray(matches))
    ) {
      this.#logger.warn({
        msg: 'catalog.claim-terms.certification-malformed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    }
    return ok((value as unknown[][]).map((matches) => matches.length > 0));
  }
}
