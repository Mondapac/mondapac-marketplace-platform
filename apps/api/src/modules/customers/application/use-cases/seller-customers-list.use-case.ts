import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_SELLER_CUSTOMERS_VIEW } from '../../contracts/permissions';
import {
  listSellerCustomers,
  parseSellerCustomerPage,
  sellerOfCall,
  sellerRowOfRecord,
  type SellerCustomerDependencies,
  type SellerCustomerListOutput,
  type SellerCustomerRowView,
  type SellerCustomersValidationFailure,
} from '../seller-customers-flow';

export type SellerCustomersReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | SellerCustomersValidationFailure;

/**
 * `customers.seller-customers-list`: the shop's Customers list, a super list (customers management
 * phase 3). Tabs all, buyers (an order with the shop) and followers; search by the customer's code
 * for this shop; filters (follower, last order dates, order count, amount spent); a sort; a page
 * number with the total, or a cursor. A row is the customer's code for this shop, their first name
 * and their numbers with this shop only: never an account id, an email or a full name. Rule: the
 * seller key `customers.seller-customers.view`, denied while the shop is not approved; the shop is
 * the session's, never an input; a Login as Seller session is refused.
 */
export class SellerCustomersList extends UseCase<
  unknown,
  SellerCustomerListOutput<SellerCustomerRowView>,
  SellerCustomersReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-customers-list',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_SELLER_CUSTOMERS_VIEW.key] },
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
    input: unknown,
  ): Promise<Result<SellerCustomerListOutput<SellerCustomerRowView>, SellerCustomersReadFailure>> {
    const sellerId = sellerOfCall(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const request = parseSellerCustomerPage(input);
    if (!request.ok) return request;
    return listSellerCustomers(this.deps, context, sellerId, request.value, sellerRowOfRecord);
  }
}
