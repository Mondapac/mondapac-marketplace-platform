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
    const mapped = copyMatches(answer.value, texts.length);
    if (mapped === null) {
      this.#logger.warn({
        msg: 'catalog.claim-text.certification-malformed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    }
    return ok(mapped);
  }
}

const isIndex = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/**
 * Copies the type code and span of each match, or `null` when the answer is not exactly one list
 * of well-formed matches per text (an unknown shape is unavailable, never an empty answer).
 */
function copyMatches(answer: unknown, expected: number): ClaimTextMatch[][] | null {
  if (!Array.isArray(answer) || answer.length !== expected) return null;
  const out: ClaimTextMatch[][] = [];
  for (const matches of answer as unknown[]) {
    if (!Array.isArray(matches)) return null;
    const copy: ClaimTextMatch[] = [];
    for (const match of matches as unknown[]) {
      if (typeof match !== 'object' || match === null) return null;
      const { typeCode, span } = match as { typeCode?: unknown; span?: unknown };
      if (typeof typeCode !== 'string' || typeCode === '') return null;
      if (span === null) {
        copy.push({ typeCode, span: null });
        continue;
      }
      if (typeof span !== 'object' || span === undefined) return null;
      const { fromToken, toToken } = span as { fromToken?: unknown; toToken?: unknown };
      if (!isIndex(fromToken) || !isIndex(toToken)) return null;
      copy.push({ typeCode, span: { fromToken, toToken } });
    }
    out.push(copy);
  }
  return out;
}
