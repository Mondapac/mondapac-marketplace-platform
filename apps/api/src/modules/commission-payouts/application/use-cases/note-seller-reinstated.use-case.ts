import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { noteSellerReinstated, type HoldEventFailure } from '../hold-flow';

interface Input {
  readonly delivery: EventDelivery;
  readonly sellerId: string;
  readonly decisionId: string;
}

/** `commission-payouts.note-seller-reinstated`, from the subscription of the same name on `identity.seller-access-reinstated.v1`: releases nothing; when a seller-suspended hold remains, appends `commission-payouts.seller-reinstated-hold-remains.v1` (notifications turns it into an admin notice). Rule `system`. */
export class NoteSellerReinstated extends UseCase<
  Input,
  'noted' | 'already-noted',
  HoldEventFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.note-seller-reinstated',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return noteSellerReinstated(this.deps, context, input);
  }
}
