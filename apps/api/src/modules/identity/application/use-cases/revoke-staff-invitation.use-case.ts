import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TEAM_MEMBER_INVITE } from '../../contracts/permissions';
import {
  changeStaffInvitation,
  type StaffInvitationChanged,
  type StaffInvitationDependencies,
  type StaffInvitationFailure,
  type StaffInvitationInput,
} from '../sellers/staff-invitation';

/**
 * Revokes a pending Staff invitation (identity design 3.4 `pending` → `revoked`; `ux.md` F11
 * step 3 "Cancel"; slice 11). Rule `permissions [identity.team-member.invite]` (protected),
 * denied while the seller is not approved. See `changeStaffInvitation`.
 */
export class RevokeStaffInvitation extends UseCase<
  StaffInvitationInput,
  StaffInvitationChanged,
  StaffInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.revoke-staff-invitation',
    rule: { kind: 'permissions', allOf: [TEAM_MEMBER_INVITE.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StaffInvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: StaffInvitationInput,
  ): Promise<Result<StaffInvitationChanged, StaffInvitationFailure>> {
    return changeStaffInvitation(this.deps, context, input, 'revoke');
  }
}
