import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OwnOpenObligations, OwnOpenObligationsFailure } from '../../contracts';
import { isActingAsSession } from '../acting-as';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * `admin-open-obligations-of`: the two counts of `open-obligations-of` for one account, asked by
 * an admin's deletion request for a buyer (customers package 5c). Rule `own-resources`: the actor
 * must be a platform admin and not an acting-as session, checked here; the calling use case holds
 * the permission. The account is a plain id read in the Market of the context. Ids and counts only.
 */
export class AdminOpenObligationsOfQuery extends UseCase<
  { readonly accountId: Id<'Account'> },
  OwnOpenObligations,
  OwnOpenObligationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-open-obligations-of',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
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
    const actor = context.actor;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.unitOfWork.run<OwnOpenObligations, OwnOpenObligationsFailure>(
      context.market,
      async () => ok(await this.deps.orders.countOpenOf(context.market, input.accountId)),
      { readOnly: true },
    );
  }
}
