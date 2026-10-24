import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  bookCarrierDeliveries,
  type CarrierStepFailure,
  type CarrierStepOutput,
} from '../carrier-flow';
import type { OrderingDependencies } from '../checkout-flow';

interface BookCarrierDeliveriesInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
}

/**
 * `ordering.book-carrier-deliveries`, from the subscription `ordering.book-carrier-deliveries`
 * on `ordering.order-paid.v1` (SHP-02/03): offers each seller order of the paid order to
 * shipping's `real_time_delivery` strategy. Rule `system`. A temporary fault throws in the
 * subscription, so the delivery is retried.
 */
export class BookCarrierDeliveries extends UseCase<
  BookCarrierDeliveriesInput,
  CarrierStepOutput,
  CarrierStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.book-carrier-deliveries',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: BookCarrierDeliveriesInput) {
    return bookCarrierDeliveries(this.deps, context, input);
  }
}
