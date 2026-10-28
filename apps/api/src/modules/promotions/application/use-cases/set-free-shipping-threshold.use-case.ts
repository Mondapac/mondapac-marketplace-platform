import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import { setThreshold } from '../admin-settings-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** `promotions.set-free-shipping-threshold`: an admin sets the free-shipping threshold of a delivery zone, or returns the zone to the Market default. */
export class SetFreeShippingThreshold extends UseCase<
  { readonly zoneCode?: unknown; readonly thresholdMinor?: unknown },
  { readonly zoneCode: string; readonly thresholdMinor: bigint | null },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.set-free-shipping-threshold',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly zoneCode?: unknown; readonly thresholdMinor?: unknown },
  ): Promise<
    Result<{ readonly zoneCode: string; readonly thresholdMinor: bigint | null }, PromotionsFailure>
  > {
    return setThreshold(this.deps, context, input);
  }
}
