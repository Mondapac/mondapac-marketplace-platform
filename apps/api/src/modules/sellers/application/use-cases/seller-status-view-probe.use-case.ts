import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCESS_VIEW } from '../../../identity';

/**
 * `sellers.seller-status-view-probe`: asks the gate whether the caller holds
 * `identity.seller-access.view`. It reads and writes nothing. The Sellers super list (list 15)
 * calls it to decide whether a row shows the status and the owner, and whether the identity
 * state tabs and their counts are open to the caller (the key of `LIST_STATUS_ACCESS` of the
 * older list); `access.denied` means "no". `identity` checks the key again on each read.
 */
export class SellerStatusViewProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-status-view-probe',
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_VIEW.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    void context;
    return Promise.resolve(ok({ held: true }));
  }
}
