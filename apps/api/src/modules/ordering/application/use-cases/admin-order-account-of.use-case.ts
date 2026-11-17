import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import { isActingAsSession } from '../acting-as';
import type { OrderingDependencies } from '../checkout-flow';

export type AdminOrderAccountOfFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'ordering.order-not-found' };

/**
 * `ordering.admin-order-account-of`: the customer account that placed an order, by the order's id
 * (the order "number" the panels show), for the admin Customers search (customers management phase
 * 2b, gap a). Rule: `permissions [ordering.order.view]`, a platform admin that is not acting as a
 * seller. An unknown id, text that is no order id and another Market's order are all
 * `ordering.order-not-found`, so nothing tells them apart. The account id only. Not over HTTP.
 */
export class AdminOrderAccountOf extends UseCase<
  { readonly orderId: unknown },
  { readonly accountId: Id<'Account'> },
  AdminOrderAccountOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-order-account-of',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly orderId: unknown },
  ): Promise<Result<{ readonly accountId: Id<'Account'> }, AdminOrderAccountOfFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const parsed = typeof input.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'ordering.order-not-found' });
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => ok(await this.deps.orders.findById(context.market, parsed.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'ordering.order-not-found' });
    return ok({ accountId: read.value.accountId });
  }
}
