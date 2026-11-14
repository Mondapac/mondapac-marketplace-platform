import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SettingsFacade } from '../../settings';
import type { DescriptionWriterSwitches } from '../application/ports/description-writer';

/**
 * {@link DescriptionWriterSwitches} on the settings facade (the Market's switch and tier,
 * ADR-0026) and the sellers facade (the seller's switch, SEL-25). Only an explicit "on" is on: a
 * refusal, an unknown seller, an error or a throw is off (ADR-0019 decision 7, R8).
 */
export class FacadeDescriptionWriterSwitches implements DescriptionWriterSwitches {
  constructor(
    private readonly settings: SettingsFacade,
    private readonly sellers: SellersFacade,
  ) {}

  async market(context: CallContext) {
    try {
      const setting = await this.settings.aiDescriptionWriter(context);
      return {
        enabled: setting.enabled === true,
        tier: setting.tier === 'balanced' ? ('balanced' as const) : ('fast' as const),
      };
    } catch {
      return { enabled: false, tier: 'fast' as const };
    }
  }

  async seller(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean> {
    try {
      const answer = await this.sellers.aiAccessOf(context, sellerId);
      return answer.ok && answer.value === true;
    } catch {
      return false;
    }
  }
}
