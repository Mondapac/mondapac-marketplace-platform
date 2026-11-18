import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BUYER_ACCOUNT_DELETE } from '../../contracts/permissions';

/**
 * `customers.buyer-delete-probe`: asks the gate whether the caller holds the key
 * `customers.buyer-account.delete`. It reads and writes nothing. The Account deletion requests list
 * calls it to name the row actions the caller may run (Cancel…); `access.denied` means "no".
 * Cancelling checks the key, the step-up and the status again when it runs.
 */
export class BuyerDeleteProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.buyer-delete-probe',
    rule: { kind: 'permissions', allOf: [BUYER_ACCOUNT_DELETE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    void context;
    return Promise.resolve(ok({ held: true }));
  }
}
