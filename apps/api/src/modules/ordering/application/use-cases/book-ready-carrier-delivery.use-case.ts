import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  bookReadyCarrierDelivery,
  type CarrierStepFailure,
  type CarrierStepOutput,
} from '../carrier-flow';
import type { OrderingDependencies } from '../checkout-flow';

interface BookReadyCarrierDeliveryInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
  readonly sellerOrderId: string;
}

/**
 * `ordering.book-ready-carrier-delivery`, from the subscription of the same name on
 * `ordering.seller-order-ready.v1`: books the carrier for an `instant` or `same_day` seller order
 * once its seller said it is ready. Rule `system`. A temporary fault throws in the subscription,
 * so the delivery is retried.
 */
export class BookReadyCarrierDelivery extends UseCase<
  BookReadyCarrierDeliveryInput,
  CarrierStepOutput,
  CarrierStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.book-ready-carrier-delivery',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: BookReadyCarrierDeliveryInput) {
    return bookReadyCarrierDelivery(this.deps, context, input);
  }
}
