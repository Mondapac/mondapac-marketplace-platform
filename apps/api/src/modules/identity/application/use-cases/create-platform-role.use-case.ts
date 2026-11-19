import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { SystemRequestRecorder } from '../../../../platform/change-review/change-review';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PLATFORM_ROLE_CREATE } from '../../contracts/permissions';
import type { ReviewRef } from '../people/people-review';
import {
  createCustomRole,
  type CreateRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
  type RoleWritten,
} from '../roles/role-editor';

// Create a custom platform role (identity design 5.3 `identity.platform-role.create`, 5.4 R1 to R3,
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

/** The creation's answer: the role and the review it opened (null when the area is off). */
export interface PlatformRoleCreated extends RoleWritten {
  readonly request: ReviewRef | null;
}

/** The ports of the platform create: the role editor's and System requests' recorder. */
export interface CreatePlatformRoleDependencies extends RoleEditorDependencies {
  readonly review: SystemRequestRecorder;
}

/**
 * Creates a custom platform role: a name and a key set the actor may grant (R1, R11). The role
 * goes live at once and is reviewed in Admin Inbox › System requests (area people, high risk;
 * owner decision of 18 Nov 2026): its request opens in the creation's unit with the admin's
 * `note`; a reviewer's reject deletes the role only while nobody holds it and its keys are
 * unchanged (people-reverters.ts).
 */
export class CreatePlatformRole extends UseCase<
  CreateRoleInput,
  PlatformRoleCreated,
  RoleEditorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.create-platform-role',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_CREATE.key] },
  };

  readonly #logger = new Logger('CreatePlatformRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CreatePlatformRoleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CreateRoleInput,
  ): Promise<Result<PlatformRoleCreated, RoleEditorFailure>> {
    const result = await createCustomRole(
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
