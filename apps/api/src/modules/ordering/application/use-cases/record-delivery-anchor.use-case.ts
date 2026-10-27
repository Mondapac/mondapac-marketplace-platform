import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OrderingDependencies } from '../checkout-flow';
import {
  recordDeliveryAnchor,
  type DeliveryAnchorFailure,
  type DeliveryAnchorOutput,
} from '../delivery-anchor-flow';

interface RecordDeliveryAnchorInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly source: string;
}

/**
 * `ordering.record-delivery-anchor`, from the subscription `ordering.record-delivery-anchor` on
 * `ordering.seller-order-delivered.v1` (payout eligibility, package 6b): hands the delivery facts
 * of the seller order to commission-payouts. Rule `system`.
 */
export class RecordDeliveryAnchor extends UseCase<
  RecordDeliveryAnchorInput,
  DeliveryAnchorOutput,
  DeliveryAnchorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.record-delivery-anchor',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecordDeliveryAnchorInput) {
    return recordDeliveryAnchor(this.deps, context, input);
  }
}
