import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type {
  ClaimTextCheckUnavailable,
  ClaimTextMatch,
  ClaimTextMatcher,
  ClaimTextToMatch,
} from '../application/ports/claim-text-matcher';

const UNAVAILABLE = err({ code: 'claim-text.check-unavailable' } as const);

/**
 * `ClaimTextMatcher` over `certification.matchClaimTerms` (catalog design 6.1, ADR-0031 decision
 * 3: the binding that replaces the fail-closed placeholder). The caller's `CallContext` goes
 * through unchanged. Any refusal, fault or answer of the wrong shape is `unavailable`, never an
 * empty answer, so the consumer refuses the save (M8). Only the type code and the token span of
 * a match are copied; nothing of the vocabulary is kept. The facade opens its own read-only unit,
 * so callers must not hold a unit of work open (units do not nest).
 */
export class CertificationClaimTextMatcher implements ClaimTextMatcher {
  readonly #logger = new Logger('CertificationClaimTextMatcher');

  constructor(private readonly certification: CertificationFacade) {}

  async match(
    context: CallContext,
    texts: readonly ClaimTextToMatch[],
  ): Promise<Result<readonly (readonly ClaimTextMatch[])[], ClaimTextCheckUnavailable>> {
    let answer: Awaited<ReturnType<CertificationFacade['matchClaimTerms']>>;
    try {
      answer = await this.certification.matchClaimTerms(
        context,
        texts.map(({ locale, text }) => ({ locale, text })),
      );
    } catch (error) {
      this.#logger.warn({
        msg: 'catalog.claim-text.certification-failed',
        reason: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    }
    if (!answer.ok) {
      this.#logger.warn({
        msg: 'catalog.claim-text.certification-refused',
        code: answer.error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    }
    if (answer.value.length !== texts.length) return UNAVAILABLE;
    return ok(
      answer.value.map((matches) =>
        matches.map((match) => ({
          typeCode: match.typeCode,
          span: match.span === null ? null : { ...match.span },
        })),
      ),
    );
  }
}
