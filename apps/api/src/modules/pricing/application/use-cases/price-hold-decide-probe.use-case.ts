import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_HOLD_DECIDE } from '../../contracts/permissions';

/**
 * `pricing.price-hold-decide-probe`: asks the gate whether the caller holds
 * `pricing.price-hold.decide`. It reads and writes nothing. The held-price list calls it to name
 * the row actions the caller may run; `access.denied` means "no". The decision itself checks its
 * key, the record and the submitter again when it runs.
 */
export class PriceHoldDecideProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.price-hold-decide-probe',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_DECIDE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
