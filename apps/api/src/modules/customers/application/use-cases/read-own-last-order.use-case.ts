import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReadModelDependencies } from '../read-model-dependencies';
import type { LastOrderFailure } from './read-customer-last-order.use-case';

/**
 * `customers.read-own-last-order`: the signed-in customer's own last confirmed order (rule
 * `own-resources`; a customer session only). The same answer as {@link ReadCustomerLastOrder} for
 * the customer's own account: promotions' referral check asks it with the customer's context.
 */
export class ReadOwnLastOrder extends UseCase<
  Record<string, never>,
  { readonly lastOrderAt: Temporal.Instant | null },
  LastOrderFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.read-own-last-order',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReadModelDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<{ readonly lastOrderAt: Temporal.Instant | null }, LastOrderFailure>> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return Promise.resolve(err({ code: 'validation.failed' }));
    }
    const accountId = actor.accountId;
    return this.deps.unitOfWork.run<
      { readonly lastOrderAt: Temporal.Instant | null },
      LastOrderFailure
    >(
      context.market,
      async () => {
        if (!(await this.deps.readModels.hasDirectory(context.market, accountId))) {
          return err({ code: 'customers.customer-unknown' } as const);
        }
        const stats = await this.deps.readModels.findStats(context.market, accountId);
        return ok({ lastOrderAt: stats?.lastOrderAt ?? null });
      },
      { readOnly: true },
    );
  }
}
