import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  recordCarrierProgress,
  type CarrierStepFailure,
  type CarrierStepOutput,
} from '../carrier-flow';
import type { OrderingDependencies } from '../checkout-flow';

interface RecordCarrierProgressInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
  readonly sellerOrderId: string;
}

/**
 * `ordering.record-carrier-progress`, from the subscription `ordering.record-carrier-progress` on
 * `shipping.carrier-delivery-progressed.v1` (SHP-03): records the carrier's pickup as the
 * shipment and its delivery as the delivery of the seller order. Rule `system`.
 */
export class RecordCarrierProgress extends UseCase<
  RecordCarrierProgressInput,
  CarrierStepOutput,
  CarrierStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.record-carrier-progress',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecordCarrierProgressInput) {
    return recordCarrierProgress(this.deps, context, input);
  }
}
