import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OwnOpenObligations, OwnOpenObligationsFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * `open-obligations-of`: the same two counts for one account, for the deletion job that re-checks
 * a due request before it erases (a customer may have ordered during the wait). Rule `system`;
 * the account is the caller's input, a plain id read in the Market of the context.
 */
export class OpenObligationsOfQuery extends UseCase<
  { readonly accountId: Id<'Account'> },
  OwnOpenObligations,
  OwnOpenObligationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.open-obligations-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'> },
  ): Promise<Result<OwnOpenObligations, OwnOpenObligationsFailure>> {
    return this.deps.unitOfWork.run<OwnOpenObligations, OwnOpenObligationsFailure>(
      context.market,
      async () => ok(await this.deps.orders.countOpenOf(context.market, input.accountId)),
      { readOnly: true },
    );
  }
}
