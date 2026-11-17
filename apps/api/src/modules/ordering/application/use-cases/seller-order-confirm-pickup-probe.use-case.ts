import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_CONFIRM_PICKUP } from '../../contracts/permissions';

// A probe of the order lists (super list phase 1): it asks the gate whether the caller holds one
// key, and reads and writes nothing. `access.denied` means "no". The lists call it to name the row
// actions the caller may run (the row Actions menu); the action checks its key again when it runs.

type Held = { readonly held: true };
type Denied = { readonly code: 'access.denied' };

/** `ordering.seller-order-confirm-pickup-probe`: the key `ordering.seller-order.confirm-pickup`. */
export class SellerOrderConfirmPickupProbe extends UseCase<Record<string, never>, Held, Denied> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-order-confirm-pickup-probe',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_CONFIRM_PICKUP.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<Held, Denied>> {
    return Promise.resolve(ok({ held: true }));
  }
}
