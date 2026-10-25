import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { readTrackingLinks } from '../carrier-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

type Input = { readonly orderId: unknown; readonly sellerOrderIds: unknown };
type Failure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed' }
  | { readonly code: 'shipping.unavailable' };

/**
 * `shipping.carrier-tracking-links`: the https tracking links of some seller orders' carrier
 * deliveries of one order, for the buyer's order page. Rule `own-resources`, as `shipping-fees`:
 * `ordering` asks under the signed-in customer's context for seller orders it has just read from
 * that customer's own order. Shipping checks ownership itself too: the actor must be a customer
 * and the booking must belong to the order asked about. Not exposed over HTTP.
 */
export class CarrierTrackingLinks extends UseCase<Input, ReadonlyMap<string, string>, Failure> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.carrier-tracking-links',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<ReadonlyMap<string, string>, Failure>> {
    return readTrackingLinks(this.deps, context, input);
  }
}
