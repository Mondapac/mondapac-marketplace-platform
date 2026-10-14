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

export type {
  StaffInvitationChanged,
  StaffInvitationFailure,
  StaffInvitationInput,
} from '../sellers/staff-invitation';

/**
 * Sends a pending Staff invitation again (identity design 3.4 `pending` → `pending`; `ux.md` F11
 * step 3 "Resend"; slice 11). Rule `permissions [identity.team-member.invite]` (protected),
 * denied while the seller is not approved. See `changeStaffInvitation`.
 */
export class ResendStaffInvitation extends UseCase<
  StaffInvitationInput,
  StaffInvitationChanged,
  StaffInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.resend-staff-invitation',
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
    return changeStaffInvitation(this.deps, context, input, 'resend');
  }
}
