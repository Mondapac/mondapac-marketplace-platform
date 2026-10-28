import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountDeletionDependencies } from '../account-deletion-dependencies';
import {
  executeAccountDeletions,
  type ExecuteAccountDeletionsOutput,
} from '../account-deletion-flow';

/** `customers.execute-account-deletions`: carries out the due deletion requests (rule `system`, the worker's job). */
export class ExecuteAccountDeletions extends UseCase<
  Record<string, never>,
  ExecuteAccountDeletionsOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.execute-account-deletions',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AccountDeletionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ExecuteAccountDeletionsOutput, { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    return ok(await executeAccountDeletions(this.deps, context));
  }
}
