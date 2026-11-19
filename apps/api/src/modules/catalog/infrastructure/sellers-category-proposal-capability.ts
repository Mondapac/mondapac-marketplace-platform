import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { CategoryProposalCapability } from '../application/ports/category-proposal-capability';

/**
 * {@link CategoryProposalCapability} on `sellers.mayProposeCategories`. Only `ok(true)` allows;
 * a refusal, an unknown seller, an error or a throw is "not allowed" (fail closed).
 */
export class SellersCategoryProposalCapability implements CategoryProposalCapability {
  constructor(private readonly sellers: SellersFacade) {}

  async allows(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    try {
      const answer = await this.sellers.mayProposeCategories(context, sellerId);
      return answer.ok && answer.value === true;
    } catch {
      return false;
    }
  }
}
