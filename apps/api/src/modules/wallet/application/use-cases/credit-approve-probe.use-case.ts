import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_CREDIT_APPROVE } from '../../contracts/permissions';

/**
 * `wallet.credit-approve-probe`: asks the gate whether the caller holds the key
 * `wallet.credit.approve`. It reads and writes nothing. The Credit requests list calls it to name
 * the row actions the caller may run (Approve… and Reject…); `access.denied` means "no". Approving
 * and rejecting check the key, the step-up, the four-eyes rule and the expiry again when they run.
 */
export class CreditApproveProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.credit-approve-probe',
    rule: { kind: 'permissions', allOf: [WALLET_CREDIT_APPROVE.key] },
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
