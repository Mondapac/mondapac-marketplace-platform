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

export type {
  SellerOwnerInvitationChanged,
  SellerOwnerInvitationFailure,
} from '../sellers/seller-owner-invitation';

/**
 * Sends a pending seller-owner invitation again (identity design 3.4 `pending` → `pending`;
 * `ux.md` F9 step 6 "Resend"; slice 9). Rule `permissions [identity.seller-account.create]`. See
 * `changeSellerOwnerInvitation`.
 */
export class ResendSellerInvitation extends UseCase<
  SellerOwnerInvitationInput,
  SellerOwnerInvitationChanged,
  SellerOwnerInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.resend-seller-invitation',
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
    return changeSellerOwnerInvitation(this.deps, context, input, 'resend');
  }
}
