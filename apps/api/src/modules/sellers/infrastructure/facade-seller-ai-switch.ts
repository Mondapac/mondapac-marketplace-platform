import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerAiSwitch } from '../../../platform/ai/seller-ai-switch';
import type { SellersFacade } from '../contracts/sellers.facade';

/**
 * sellers' implementation of `platform/ai`'s {@link SellerAiSwitch} port (SEL-25; ADR-0019
 * decision 7): the seller's AI switch, read through `aiAccessOf`, which answers every actor the
 * same. Only an explicit "on" is on: a refusal, an unknown seller, an error or a throw is off.
 */
export class FacadeSellerAiSwitch implements SellerAiSwitch {
  constructor(private readonly sellers: SellersFacade) {}

  async isOn(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    try {
      const answer = await this.sellers.aiAccessOf(context, sellerId);
      return answer.ok && answer.value === true;
    } catch {
      return false;
    }
  }
}
