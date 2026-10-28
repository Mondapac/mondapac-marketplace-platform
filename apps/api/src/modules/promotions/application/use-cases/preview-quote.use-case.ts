import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { adminAccountId } from '../caller';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { parseQuoteRequest } from '../quote-input';
import type { QuoteResult } from '../../contracts/promotions.facade';
import { quote } from '../quote-flow';

/**
 * `promotions.preview-quote`: an admin tries a hypothetical cart against the live promotions of
 * the Market, calculated on the server (nothing is reserved, saved or charged). Test mode is the
 * default so that test-mode promotions show; refused while promotions are off.
 */
export class PreviewQuote extends UseCase<unknown, QuoteResult, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.preview-quote',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<QuoteResult, PromotionsFailure>> {
    if (adminAccountId(context) === null) return err({ code: 'access.denied' });
    const settings = this.deps.policy.settings(context.market);
    if (settings === null) return err({ code: 'promotions.unavailable' });
    const request = parseQuoteRequest(input, settings.currency, { testMode: true });
    if (!request.ok) return err({ code: 'validation.failed', fields: request.error });
    return quote(this.deps, context, request.value, true);
  }
}
