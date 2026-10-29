import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { sellerIdsOf, type SellerIdsFailure } from '../seller-ids';
import type { ShippingDependencies } from '../shipping-dependencies';

export type PickupAvailabilityFailure =
  SellerIdsFailure | { readonly code: 'shipping.unavailable' };

/**
 * `shipping.pickup-availability` (delivery models, package 2, owner decision): in-person pickup
 * is offered by every seller that has an approved pickup address, and by no one else. The answer
 * is the set of the asked sellers that have one: the operating address of the seller's approved
 * business file, read as its pickup postcode (a clear column, no audit row). A seller without an
 * approved file, of another Market or without a postcode is absent. A failed read is
 * `shipping.unavailable`, never "no pickup" (fail closed on the caller's side). Rule
 * `own-resources`, as `delivery-quote`: checkout asks under the signed-in customer's context. Not
 * exposed over HTTP.
 */
export class PickupAvailability extends UseCase<
  { readonly sellerIds: unknown },
  ReadonlySet<Id<'Seller'>>,
  PickupAvailabilityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.pickup-availability',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly sellerIds: unknown },
  ): Promise<Result<ReadonlySet<Id<'Seller'>>, PickupAvailabilityFailure>> {
    const parsed = sellerIdsOf(input?.sellerIds);
    if (!parsed.ok) return parsed;
    if (parsed.value.length === 0) return ok(new Set());
    const postcodes = await this.deps.pickups.postcodesOf(context, parsed.value);
    if (!postcodes.ok) return err({ code: 'shipping.unavailable' });
    return ok(new Set(postcodes.value.keys()));
  }
}
