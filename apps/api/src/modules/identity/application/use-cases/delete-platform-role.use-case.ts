import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { SystemActionProposer } from '../../../../platform/change-review/change-review';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PLATFORM_ROLE_DELETE } from '../../contracts/permissions';
import type { ReviewRef } from '../people/people-review';
import {
  deleteOrProposeCustomRole,
  type DeleteRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
} from '../roles/role-editor';

// Delete a custom platform role (identity design 5.3 `identity.platform-role.delete`, 5.4 R1 to R3,
// R5, R7, R9 to R11; slice 10): a thin use case over the shared core in `roles/role-editor.ts`,
// with its own protected key as the rule. The keys are protected (R11), so in Phase 2 only a holder of the Platform
// Administrator role, or of a custom role it created with them, can run it.

const EDITOR: RoleEditorScope = {
  scope: 'platform',
  population: 'admin',
  createKey: 'identity.platform-role.create',
  editKey: 'identity.platform-role.edit',
  deleteKey: 'identity.platform-role.delete',
};

/**
 * The delete's answer: `role.deleted` (request null: the area is off), or `role.delete-requested`
 * with the request that waits for another admin's approval.
 */
export interface PlatformRoleDeleted {
  readonly code: 'role.deleted' | 'role.delete-requested';
  readonly roleId: Id<'Role'>;
  readonly request: ReviewRef | null;
}

/** The ports of the platform delete: the role editor's and System requests' proposer. */
export interface DeletePlatformRoleDependencies extends RoleEditorDependencies {
  readonly proposer: SystemActionProposer;
}

/**
 * Deletes a custom platform role that no account holds; never a seeded role. Where the Market
 * reviews area people, the delete waits for another admin's approval in Admin Inbox › System
 * requests (owner decision of 18 Nov 2026): the request is filed with the admin's `note` and
 * nothing is deleted until the approval, which checks again that the role is unchanged and unheld
 * (people-creations.ts).
 */
export class DeletePlatformRole extends UseCase<
  DeleteRoleInput,
  PlatformRoleDeleted,
  RoleEditorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.delete-platform-role',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_DELETE.key] },
  };

  readonly #logger = new Logger('DeletePlatformRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeletePlatformRoleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: DeleteRoleInput,
  ): Promise<Result<PlatformRoleDeleted, RoleEditorFailure>> {
    const result = await deleteOrProposeCustomRole(
      this.deps,
      EDITOR,
      this.#logger,
      context,
      input,
      this.deps.proposer,
    );
    if (!result.ok) return result;
    const { code, roleId, request } = result.value;
    // A platform delete answers only these two codes (no create or edit runs here).
    return ok({
      code: code === 'role.delete-requested' ? code : 'role.deleted',
      roleId,
      request: request ?? null,
    });
  }
}
