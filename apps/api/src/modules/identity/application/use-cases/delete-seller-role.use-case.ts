import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ROLE_DELETE } from '../../contracts/permissions';
import {
  deleteCustomRole,
  type DeleteRoleInput,
  type RoleEditorDependencies,
  type RoleEditorFailure,
  type RoleEditorScope,
  type RoleWritten,
} from '../roles/role-editor';

// Delete a custom seller role (identity design 5.3 `identity.seller-role.delete`, 5.4 R1 to R3,
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

/** Deletes a custom seller role that no account holds; never a seeded role. */
export class DeleteSellerRole extends UseCase<DeleteRoleInput, RoleWritten, RoleEditorFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.delete-seller-role',
    rule: { kind: 'permissions', allOf: [SELLER_ROLE_DELETE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('DeleteSellerRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RoleEditorDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DeleteRoleInput,
  ): Promise<Result<RoleWritten, RoleEditorFailure>> {
    return deleteCustomRole(this.deps, EDITOR, this.#logger, context, input);
  }
}
