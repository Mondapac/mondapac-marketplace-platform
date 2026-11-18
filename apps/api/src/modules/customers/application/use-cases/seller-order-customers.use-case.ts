import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import type {
  SellerOrderCustomer,
  SellerOrderCustomersFailure,
} from '../../contracts/customers-read.facade';
import { sellerOfCall, type SellerCustomerDependencies } from '../seller-customers-flow';

/**
 * `ordering.seller-order.view`, written out: importing it from `ordering` here would load that
 * module while `customers` is still loading (ordering imports customers). A spec checks it is
 * ordering's key.
 */
export const SELLER_ORDER_VIEW_KEY = 'ordering.seller-order.view' as PermissionKey;

/** At most this many accounts per call (one order page asks for one, a slip page for 50). */
export const MAX_SELLER_ORDER_CUSTOMERS = 100;

interface SellerOrderCustomersInput {
  readonly accountIds: readonly Id<'Account'>[];
}

/**
 * `customers.seller-order-customers`: how the calling shop knows the customers of its own orders,
 * by the customer's code for that shop and first name only (owner decision 2026-11-17: the same
 * restriction as the shop's Customers list). `ordering` calls it through the read facade with the
 * seller's `CallContext` unchanged, for accounts it read from the seller's own paid seller
 * orders. Rule `permissions [ordering.seller-order.view]`: a member who may see the order may see
 * who it is for, in this form only. Denied while the seller is not approved, and to a Login as
 * Seller session. An account the shop has no row for yet (the sync runs after payment) is absent.
 * The account id is the map key only: it is never put in an answer that leaves the API.
 */
export class SellerOrderCustomers extends UseCase<
  SellerOrderCustomersInput,
  ReadonlyMap<Id<'Account'>, SellerOrderCustomer>,
  SellerOrderCustomersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-order-customers',
    rule: { kind: 'permissions', allOf: [SELLER_ORDER_VIEW_KEY] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerOrderCustomersInput,
  ): Promise<Result<ReadonlyMap<Id<'Account'>, SellerOrderCustomer>, SellerOrderCustomersFailure>> {
    const sellerId = sellerOfCall(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const raw = input?.accountIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_SELLER_ORDER_CUSTOMERS) {
      return err({ code: 'validation.failed' });
    }
    const accountIds = new Set<Id<'Account'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Account'>(value) : null;
      if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
      accountIds.add(parsed.value);
    }
    if (accountIds.size === 0) return ok(new Map());
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      context.market,
      async () =>
        ok(await deps.sellerCustomers.findByAccounts(context.market, sellerId, [...accountIds])),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const customers = new Map<Id<'Account'>, SellerOrderCustomer>();
    for (const record of read.value) {
      // Only what was asked for, and only this shop's rows.
      if (record.sellerId !== sellerId || !accountIds.has(record.accountId)) continue;
      customers.set(record.accountId, { code: record.code, firstName: record.firstName });
    }
    return ok(customers);
  }
}
