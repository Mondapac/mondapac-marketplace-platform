import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_MARK_READY } from '../../contracts/permissions';

// A probe of the order lists (super list phase 1): it asks the gate whether the caller holds one
// key, and reads and writes nothing. `access.denied` means "no". The lists call it to name the row
// actions the caller may run (the row Actions menu); the action checks its key again when it runs.

type Held = { readonly held: true };
type Denied = { readonly code: 'access.denied' };

/** `ordering.seller-order-mark-ready-probe`: the key `ordering.seller-order.mark-ready`. */
export class SellerOrderMarkReadyProbe extends UseCase<Record<string, never>, Held, Denied> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-order-mark-ready-probe',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_MARK_READY.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<Held, Denied>> {
    return Promise.resolve(ok({ held: true }));
  }
}
