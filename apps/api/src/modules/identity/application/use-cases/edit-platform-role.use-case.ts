import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { SystemRequestRecorder } from '../../../../platform/change-review/change-review';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PLATFORM_ROLE_EDIT } from '../../contracts/permissions';
import {
  editCustomRole,
  type EditRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
  type RoleWritten,
} from '../roles/role-editor';
import type { ReviewRef } from '../people/people-review';

// Edit a custom platform role (identity design 5.3 `identity.platform-role.edit`, 5.4 R1 to R3,
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

/** The edit's answer: the role and the review it opened (null when the area is off or unchanged). */
export interface PlatformRoleEdited extends RoleWritten {
  readonly request: ReviewRef | null;
}

/** The ports of the platform edit: the role editor's and System requests' recorder. */
export interface EditPlatformRoleDependencies extends RoleEditorDependencies {
  readonly review: SystemRequestRecorder;
}

/**
 * Edits a custom platform role's name and keys; never a seeded role (R3, R10). The edit is
 * reviewed in Admin Inbox › System requests (area people, high risk): its request opens in the
 * edit's unit with the admin's `note`; a reviewer's reject restores the role only if that removes
 * keys or renames (people-reverters.ts), never if it would add a key.
 */
export class EditPlatformRole extends UseCase<
  EditRoleInput,
  PlatformRoleEdited,
  RoleEditorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.edit-platform-role',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_EDIT.key] },
  };

  readonly #logger = new Logger('EditPlatformRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: EditPlatformRoleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: EditRoleInput,
  ): Promise<Result<PlatformRoleEdited, RoleEditorFailure>> {
    const result = await editCustomRole(
      this.deps,
      EDITOR,
      this.#logger,
      context,
      input,
      this.deps.review,
    );
    return result.ok ? ok({ ...result.value, request: result.value.request ?? null }) : result;
  }
}
