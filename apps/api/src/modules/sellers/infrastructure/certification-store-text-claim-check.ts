import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type {
  ClaimCheckUnavailable,
  StoreTextClaimCheck,
} from '../application/ports/store-text-claim-check';

const UNAVAILABLE = err({ code: 'claim-text.check-unavailable' } as const);

/**
 * {@link StoreTextClaimCheck} over `certification.matchClaimTerms` (certification design 8.1;
 * the same binding catalog uses for product text). Any refusal, fault or answer of the wrong
 * shape is unavailable, never an empty answer, so the save is refused (M8). Only whether a text
 * matched is kept: no term, type code or span leaves this class. Bound by
 * `SellerStoreProfileModule`; the facade opens a read-only unit of its own.
 */
export class CertificationStoreTextClaimCheck implements StoreTextClaimCheck {
  readonly #logger = new Logger('CertificationStoreTextClaimCheck');

  constructor(private readonly certification: CertificationFacade) {}

  async flagged(
    context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], ClaimCheckUnavailable>> {
    let answer: Awaited<ReturnType<CertificationFacade['matchClaimTerms']>>;
    try {
      answer = await this.certification.matchClaimTerms(
        context,
        texts.map(({ locale, text }) => ({ locale, text })),
      );
    } catch (error) {
      this.#log(context, 'sellers.store-text.certification-failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return UNAVAILABLE;
    }
    if (!answer.ok) {
      this.#log(context, 'sellers.store-text.certification-refused', { code: answer.error.code });
      return UNAVAILABLE;
    }
    const matches: unknown = answer.value;
    if (!Array.isArray(matches) || matches.length !== texts.length) {
      this.#log(context, 'sellers.store-text.certification-malformed', {});
      return UNAVAILABLE;
    }
    const flags: boolean[] = [];
    for (const one of matches as unknown[]) {
      if (!Array.isArray(one)) {
        this.#log(context, 'sellers.store-text.certification-malformed', {});
        return UNAVAILABLE;
      }
      flags.push(one.length > 0);
    }
    return ok(flags);
  }

  #log(context: CallContext, msg: string, extra: object): void {
    this.#logger.warn({
      msg,
      ...extra,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
