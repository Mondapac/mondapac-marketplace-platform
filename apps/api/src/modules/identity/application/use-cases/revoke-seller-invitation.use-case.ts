import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCOUNT_CREATE } from '../../contracts/permissions';
import {
  changeSellerOwnerInvitation,
  type SellerOwnerInvitationChanged,
  type SellerOwnerInvitationDependencies,
  type SellerOwnerInvitationFailure,
  type SellerOwnerInvitationInput,
} from '../sellers/seller-owner-invitation';

/**
 * Revokes a pending seller-owner invitation (identity design 3.4 `pending` → `revoked`; `ux.md`
 * F9 step 6 "Cancel"; slice 9). Rule `permissions [identity.seller-account.create]`. The seller
 * stays, without an owner, and can be invited again (HF5 (a)). See `changeSellerOwnerInvitation`.
 */
export class RevokeSellerInvitation extends UseCase<
  SellerOwnerInvitationInput,
  SellerOwnerInvitationChanged,
  SellerOwnerInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.revoke-seller-invitation',
    rule: { kind: 'permissions', allOf: [SELLER_ACCOUNT_CREATE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerOwnerInvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerOwnerInvitationInput,
  ): Promise<Result<SellerOwnerInvitationChanged, SellerOwnerInvitationFailure>> {
    return changeSellerOwnerInvitation(this.deps, context, input, 'revoke');
  }
}
