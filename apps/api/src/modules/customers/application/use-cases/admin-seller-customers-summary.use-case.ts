import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  adminOfCall,
  invalid,
  sellerCustomerSummary,
  type SellerCustomerDependencies,
  type SellerCustomerSummary,
} from '../seller-customers-flow';
import type { SellerCustomersReadFailure } from './seller-customers-list.use-case';

/**
 * `customers.admin-seller-customers-summary`: the head of a seller's Customers tab: how many
 * customers bought from the seller and follow it, and new buyers and new followers per month for
 * the last 12 months, cut in the Market's zone (the seller has no zone of its own yet). Counts
 * only. Rule as the tab's list.
 */
export class AdminSellerCustomersSummary extends UseCase<
  { readonly sellerId: string },
  SellerCustomerSummary,
  SellerCustomersReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-seller-customers-summary',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly sellerId: string },
  ): Promise<Result<SellerCustomerSummary, SellerCustomersReadFailure>> {
    if (adminOfCall(context) === null) return err({ code: 'access.denied' });
    const seller = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return invalid('sellerId', 'format');
    return sellerCustomerSummary(this.deps, context, seller.value);
  }
}
