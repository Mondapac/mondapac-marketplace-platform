import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  adminOfCall,
  adminRowView,
  invalid,
  isRecord,
  listSellerCustomers,
  parseSellerCustomerPage,
  type AdminSellerCustomerRowView,
  type SellerCustomerDependencies,
  type SellerCustomerListOutput,
} from '../seller-customers-flow';
import type { SellerCustomersReadFailure } from './seller-customers-list.use-case';

/**
 * `customers.admin-seller-customers-list`: the Customers tab of a seller's page in the admin
 * panel: the seller's customers (bought, followers) as the seller's own list has them, with the
 * account id for the link to the customer's page. Rule: the key `customers.customers.view` and
 * the admin population; a Login as Seller session is refused. Body: `sellerId` plus the list's keys.
 */
export class AdminSellerCustomersList extends UseCase<
  unknown,
  SellerCustomerListOutput<AdminSellerCustomerRowView>,
  SellerCustomersReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-seller-customers-list',
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
    input: unknown,
  ): Promise<
    Result<SellerCustomerListOutput<AdminSellerCustomerRowView>, SellerCustomersReadFailure>
  > {
    if (adminOfCall(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalid('body', 'type');
    const { sellerId: rawSeller, ...rest } = input;
    const seller = typeof rawSeller === 'string' ? parseId<'Seller'>(rawSeller) : null;
    if (seller === null || !seller.ok) return invalid('sellerId', 'format');
    const request = parseSellerCustomerPage(rest);
    if (!request.ok) return request;
    return listSellerCustomers(this.deps, context, seller.value, request.value, adminRowView);
  }
}
