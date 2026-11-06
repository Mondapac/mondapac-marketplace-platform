import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type {
  CategoryRetirementCheck,
  CategoryRetirementRefusal,
} from '../application/ports/category-retirement-check';

const UNAVAILABLE = err({ code: 'category.check-unavailable' } as const);
const TYPE_CODE = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_TYPE_CODES = 100;

/**
 * {@link CategoryRetirementCheck} over certification's facade (request C-4). The caller's
 * `CallContext` goes through unchanged. Only a well-formed `category.referenced-by-policy` with
 * type codes is passed on; any other refusal, a fault or a malformed answer is unavailable, never
 * `ok`.
 */
export class CertificationCategoryRetirement implements CategoryRetirementCheck {
  readonly #logger = new Logger('CertificationCategoryRetirement');

  constructor(private readonly certification: CertificationFacade) {}

  async assertRetirable(
    context: CallContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<Result<void, CategoryRetirementRefusal>> {
    let answer: unknown;
    try {
      answer = await this.certification.assertCategoriesRetirable(context, categoryIds);
    } catch (error) {
      return this.#fail(context, 'assert', error instanceof Error ? error.name : 'unknown');
    }
    const { ok: answered, error } = (answer ?? {}) as { ok?: unknown; error?: unknown };
    if (answered === true) return ok(undefined);
    const refusal = (error ?? {}) as { code?: unknown; typeCodes?: unknown };
    if (
      refusal.code === 'category.referenced-by-policy' &&
      Array.isArray(refusal.typeCodes) &&
      refusal.typeCodes.length > 0 &&
      refusal.typeCodes.length <= MAX_TYPE_CODES &&
      refusal.typeCodes.every((code) => typeof code === 'string' && TYPE_CODE.test(code))
    ) {
      return err({
        code: 'category.referenced-by-policy',
        typeCodes: [...(refusal.typeCodes as string[])],
      });
    }
    return this.#fail(context, 'assert', typeof refusal.code === 'string' ? refusal.code : 'shape');
  }

  async retired(
    context: CallContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<Result<void, { readonly code: 'category.check-unavailable' }>> {
    let answer: unknown;
    try {
      answer = await this.certification.platformCategoriesRetired(context, categoryIds);
    } catch (error) {
      return this.#fail(context, 'retired', error instanceof Error ? error.name : 'unknown');
    }
    const { ok: answered, error } = (answer ?? {}) as { ok?: unknown; error?: { code?: unknown } };
    if (answered === true) return ok(undefined);
    return this.#fail(context, 'retired', typeof error?.code === 'string' ? error.code : 'shape');
  }

  #fail(context: CallContext, call: string, reason: string): typeof UNAVAILABLE {
    this.#logger.warn({
      msg: 'catalog.category-retirement.unavailable',
      call,
      reason,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return UNAVAILABLE;
  }
}
