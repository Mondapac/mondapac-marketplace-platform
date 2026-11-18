import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE } from '../../contracts/permissions';

/**
 * `commission-payouts.dispute-attribute-probe`: asks the gate whether the caller holds the key
 * `commission-payouts.dispute.attribute`. It reads and writes nothing. The Disputes list calls it to name the row actions
 * the caller may run (the row Actions menu); `access.denied` means "no". The action itself checks
 * its key again when it runs.
 */
export class DisputeAttributeProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.dispute-attribute-probe',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE.key] },
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
