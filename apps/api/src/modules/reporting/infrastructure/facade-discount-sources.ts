import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { DiscountCostKind, PromotionsReportingFacade } from '../../promotions';
import type { DiscountSources } from '../application/ports/discount-sources';
import type { DiscountKind, DiscountTotals } from '../domain/discount-cost';
import type { InstantWindow } from '../domain/period';

const KINDS: Readonly<Record<DiscountCostKind, DiscountKind>> = {
  PROMOTION: 'promotion',
  FIRST_ORDER: 'first-order',
  FREE_SHIPPING: 'free-shipping',
};

/**
 * {@link DiscountSources} on promotions' `discountCost`. A refusal of the key passes through (the
 * dashboard leaves the section out); anything else is `access.unavailable`.
 */
export class FacadeDiscountSources implements DiscountSources {
  constructor(private readonly promotions: Pick<PromotionsReportingFacade, 'discountCost'>) {}

  async totalsOf(
    context: CallContext,
    currency: string,
    window: InstantWindow,
  ): Promise<Result<DiscountTotals, AccessDenied | { readonly code: 'access.unavailable' }>> {
    const answer = await this.promotions.discountCost(context, { window, currency });
    if (!answer.ok) {
      const { code } = answer.error;
      if (code.startsWith('access.') && code !== 'access.unavailable') {
        return err(answer.error as AccessDenied);
      }
      return err({ code: 'access.unavailable' });
    }
    const { kept, byKind, released } = answer.value;
    return ok({
      kept: { ...kept },
      byKind: byKind.map((row) => ({ ...row, kind: KINDS[row.kind] })),
      released: { ...released },
    });
  }
}
