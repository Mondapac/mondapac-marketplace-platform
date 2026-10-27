import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  expireAdminCredits,
  type AdminCreditExpiryReport,
  type AdminCreditFailure,
} from '../admin-credit-flow';
import type { AdminCreditDependencies } from '../wallet-dependencies';

/**
 * `wallet.expire-admin-credit-requests`: the worker's sweep. Pending admin credit requests past
 * their expiry become `expired` (audited); no money moves. Rule `system`.
 */
export class ExpireAdminCreditRequests extends UseCase<
  Record<string, never>,
  AdminCreditExpiryReport,
  AdminCreditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.expire-admin-credit-requests',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCreditDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return expireAdminCredits(this.deps, context);
  }
}
