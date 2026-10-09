import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ROLE_CREATE } from '../../contracts/permissions';
import {
  createCustomRole,
  type CreateRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
  type RoleWritten,
} from '../roles/role-editor';

// Create a custom seller role (identity design 5.3 `identity.seller-role.create`, 5.4 R1 to R3,
// R5, R7, R9 to R11; slice 10): a thin use case over the shared core in `roles/role-editor.ts`,
// with its own protected key as the rule. The seller is the actor's (R6). The keys are protected, and protected seller keys are
// not grantable in Phase 2 (5.4), so only the Seller Owner runs it and a seller role never
// holds one.

const EDITOR: RoleEditorScope = {
  scope: 'seller',
  population: 'seller',
  createKey: 'identity.seller-role.create',
  editKey: 'identity.seller-role.edit',
  deleteKey: 'identity.seller-role.delete',
};

/** Creates a custom seller role: a name and a key set the actor may grant (R1, R11). */
export class CreateSellerRole extends UseCase<CreateRoleInput, RoleWritten, RoleEditorFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.create-seller-role',
    rule: { kind: 'permissions', allOf: [SELLER_ROLE_CREATE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('CreateSellerRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RoleEditorDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CreateRoleInput,
  ): Promise<Result<RoleWritten, RoleEditorFailure>> {
    return createCustomRole(this.deps, EDITOR, this.#logger, context, input);
  }
}
