import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { readTrackingLinks } from '../carrier-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

type Failure = { readonly code: 'validation.failed' } | { readonly code: 'shipping.unavailable' };

/**
 * `shipping.carrier-tracking-links`: the https tracking links of some seller orders' carrier
 * deliveries, for the buyer's order page. Rule `own-resources`, as `shipping-fees`: `ordering`
 * asks under the signed-in customer's context for seller orders it has just read from that
 * customer's own order, so ownership is checked there. Not exposed over HTTP.
 */
export class CarrierTrackingLinks extends UseCase<
  { readonly sellerOrderIds: unknown },
  ReadonlyMap<string, string>,
  Failure
> {
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
    input: { readonly sellerOrderIds: unknown },
  ): Promise<Result<ReadonlyMap<string, string>, Failure>> {
    return readTrackingLinks(this.deps, context, input);
  }
}
