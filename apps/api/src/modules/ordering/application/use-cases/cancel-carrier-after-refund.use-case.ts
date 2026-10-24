import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  cancelCarrierAfterRefund,
  type CarrierStepFailure,
  type CarrierStepOutput,
} from '../carrier-flow';
import type { OrderingDependencies } from '../checkout-flow';

interface CancelCarrierAfterRefundInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
  readonly sellerOrderId: string;
}

/**
 * `ordering.cancel-carrier-after-refund`, from the subscription of the same name on
 * `ordering.refund-succeeded.v1` (SHP-03): cancels the real-time carrier delivery of a seller
 * order refunded in full, while the carrier has not picked it up. Rule `system`.
 */
export class CancelCarrierAfterRefund extends UseCase<
  CancelCarrierAfterRefundInput,
  CarrierStepOutput,
  CarrierStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.cancel-carrier-after-refund',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CancelCarrierAfterRefundInput) {
    return cancelCarrierAfterRefund(this.deps, context, input);
  }
}
