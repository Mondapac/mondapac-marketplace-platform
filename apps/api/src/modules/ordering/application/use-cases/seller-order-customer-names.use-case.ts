import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  SellerOrderCustomerName,
  SellerOrderCustomerNamesFailure,
} from '../../contracts/ordering.facade';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { shortNamesOfSellerOrders } from '../order-labels';

/** At most this many seller orders per call (a notice page holds 20). */
export const MAX_SELLER_ORDER_IDS = 100;

/** An acting-as (Login as Seller) session sees no customer names (Hassan, the marker by name). */
function isActingAs(actor: object): boolean {
  const marker = Object.hasOwn(actor, 'actingAs')
    ? (actor as { readonly actingAs?: unknown }).actingAs
    : null;
  return marker !== null && marker !== undefined;
}

interface SellerOrderCustomerNamesInput {
  readonly sellerOrderIds: readonly string[];
}

/**
 * `seller-order-customer-names`: the short customer name ("Maryam R.") of each of the seller's
 * own paid seller orders asked for, for the order notices under the panel bell; `notifications`
 * calls it through the ordering facade with the seller's `CallContext` unchanged. Rule
 * `permissions [ordering.seller-order.view]`, denied while the seller is not approved; the seller
 * is the actor's own, so another shop's, an unknown and an unpaid seller order are absent. The
 * names come from identity's `customerShortNames`, which needs
 * `identity.customer-short-name.view` and answers nothing to a member without it. A malformed id
 * is skipped; more than 100 ids are refused whole. Nothing is stored or logged.
 */
export class SellerOrderCustomerNames extends UseCase<
  SellerOrderCustomerNamesInput,
  readonly SellerOrderCustomerName[],
  SellerOrderCustomerNamesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-order-customer-names',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerOrderCustomerNamesInput,
  ): Promise<Result<readonly SellerOrderCustomerName[], SellerOrderCustomerNamesFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'seller' || isActingAs(actor)) {
      return err({ code: 'access.denied' });
    }
    const seller = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'access.denied' });
    const raw = input?.sellerOrderIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_SELLER_ORDER_IDS) {
      return err({ code: 'validation.failed' });
    }
    const ids = new Set<Id<'SellerOrder'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'SellerOrder'>(value) : null;
      if (parsed !== null && parsed.ok) ids.add(parsed.value);
    }
    if (ids.size === 0) return ok([]);
    const accounts = await this.deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await this.deps.orders.customerAccountsForSeller(context.market, seller.value, [...ids]),
        ),
      { readOnly: true },
    );
    if (!accounts.ok) return err({ code: 'access.denied' });
    // After the read unit has closed: no facade call inside a unit.
    const names = await shortNamesOfSellerOrders(this.deps.labels, context, accounts.value);
    return ok(
      [...names].map(([sellerOrderId, customerShortName]) => ({
        sellerOrderId,
        customerShortName,
      })),
    );
  }
}
