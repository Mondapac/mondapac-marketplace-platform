import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type { ClaimTermLocales } from '../application/ports/claim-term-locales';
import type { ClaimTextCheckUnavailable } from '../application/ports/claim-text-matcher';

const UNAVAILABLE = err({ code: 'claim-text.check-unavailable' } as const);
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_LOCALES = 50;

/**
 * {@link ClaimTermLocales} over `certification.claimTermLocales` (attributes A2). The caller's
 * `CallContext` goes through unchanged. A refusal, a fault or an answer that is not a short list
 * of locale tags is unavailable, never an empty or partial answer.
 */
export class CertificationClaimTermLocales implements ClaimTermLocales {
  readonly #logger = new Logger('CertificationClaimTermLocales');

  constructor(private readonly certification: CertificationFacade) {}

  async covered(
    context: CallContext,
  ): Promise<Result<readonly string[], ClaimTextCheckUnavailable>> {
    const fail = (reason: string): typeof UNAVAILABLE => {
      this.#logger.warn({
        msg: 'catalog.claim-term-locales.unavailable',
        reason,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return UNAVAILABLE;
    };
    let answer: unknown;
    try {
      answer = await this.certification.claimTermLocales(context);
    } catch (error) {
      return fail(error instanceof Error ? error.name : 'unknown');
    }
    const { ok: answered, value } = (answer ?? {}) as { ok?: unknown; value?: unknown };
    if (answered !== true) return fail('refused');
    if (!Array.isArray(value) || value.length > MAX_LOCALES) return fail('shape');
    const locales: string[] = [];
    for (const locale of value as readonly unknown[]) {
      if (typeof locale !== 'string' || !LOCALE.test(locale)) return fail('shape');
      locales.push(locale);
    }
    return ok(locales);
  }
}
