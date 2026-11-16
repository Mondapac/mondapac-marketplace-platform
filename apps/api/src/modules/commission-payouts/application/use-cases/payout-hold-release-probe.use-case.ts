import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE } from '../../contracts/permissions';

/**
 * `commission-payouts.payout-hold-release-probe`: asks the gate whether the caller holds the key
 * `commission-payouts.payout-hold.release`. It reads and writes nothing. The Payouts list calls it to name the row actions
 * the caller may run (the row Actions menu); `access.denied` means "no". The action itself checks
 * its key again when it runs.
 */
export class PayoutHoldReleaseProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.payout-hold-release-probe',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key] },
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
