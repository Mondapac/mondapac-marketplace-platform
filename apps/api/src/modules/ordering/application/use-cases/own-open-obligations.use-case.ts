import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OwnOpenObligations, OwnOpenObligationsFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * `own-open-obligations`: how many of the calling customer's orders are still open and how many
 * refunds are still pending, as two counts (account deletion asks before it accepts a request).
 * Rule `own-resources`, customers only; the account is the session's. A read: ids and counts
 * only, no amount, address or name.
 */
export class OwnOpenObligationsQuery extends UseCase<
  Record<string, never>,
  OwnOpenObligations,
  OwnOpenObligationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.own-open-obligations',
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
  ): Promise<Result<OwnOpenObligations, OwnOpenObligationsFailure>> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.unitOfWork.run<OwnOpenObligations, OwnOpenObligationsFailure>(
      context.market,
      async () => ok(await this.deps.orders.countOpenOf(context.market, actor.accountId)),
      { readOnly: true },
    );
  }
}
