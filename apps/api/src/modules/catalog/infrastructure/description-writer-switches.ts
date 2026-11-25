import type { CallContext } from '@mondapac/shared-kernel';
import type { SettingsFacade } from '../../settings';
import type { DescriptionWriterSwitches } from '../application/ports/description-writer';

/**
 * {@link DescriptionWriterSwitches} on the settings facade (the Market's switch and tier,
 * ADR-0026). The seller's switch (SEL-25) is evaluated by the gateway through sellers' port. Only
 * an explicit "on" is on: a refusal, an error or a throw is off (ADR-0019 decision 7, R8).
 */
export class FacadeDescriptionWriterSwitches implements DescriptionWriterSwitches {
  constructor(private readonly settings: SettingsFacade) {}

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
}
