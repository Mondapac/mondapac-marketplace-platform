import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { placeSellerSuspendedHold, type HoldEventFailure } from '../hold-flow';

interface Input {
  readonly delivery: EventDelivery;
  readonly sellerId: string;
  readonly decisionId: string;
}

/** `commission-payouts.place-seller-suspended-hold`, from the subscription of the same name on `identity.seller-access-suspended.v1`: places a system `seller-suspended` hold on the whole seller, once per decision. Rule `system`. */
export class PlaceSellerSuspendedHold extends UseCase<
  Input,
  'placed' | 'already-placed',
  HoldEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.place-seller-suspended-hold',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return placeSellerSuspendedHold(this.deps, context, input);
  }
}
