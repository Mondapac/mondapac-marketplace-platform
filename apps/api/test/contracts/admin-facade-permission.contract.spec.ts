import { AdminEndCustomerSessions } from '../../src/modules/identity/application/use-cases/admin-end-customer-sessions.use-case';
import { AdminOpenObligationsOfQuery } from '../../src/modules/ordering/application/use-cases/admin-open-obligations-of.use-case';
import { AdminBalanceOf } from '../../src/modules/wallet/application/use-cases/admin-balance-of.use-case';
import { AdminRenameCustomer } from '../../src/modules/identity/application/use-cases/admin-rename-customer.use-case';
import {
  BUYER_ACCOUNT_DELETE,
  CUSTOMERS_CUSTOMER_EDIT,
  CUSTOMERS_CUSTOMER_EXPORT,
} from '../../src/modules/customers/contracts/permissions';
import { CUSTOMERS_EXPORT_STEP_UP } from '../../src/modules/customers/contracts/step-up';
import {
  CUSTOMER_DATA_EXPORT_KEY as ORDERING_CUSTOMER_DATA_EXPORT_KEY,
  CUSTOMER_DATA_EXPORT_STEP_UP as ORDERING_CUSTOMER_DATA_EXPORT_STEP_UP,
} from '../../src/modules/ordering/application/customer-refunds-list-flow';
import { AdminCustomerRefundsExport } from '../../src/modules/ordering/application/use-cases/admin-customer-refunds-export.use-case';

// Hassan M1 (customers package 5c): the three admin facade use cases the deletion request calls in
// other modules declare the key customers declared, so a Viewer admin or any other admin that does not
// hold the protected deletion key cannot call them. Only the declaring module can brand a key, so
// each module casts the literal; this test pins every literal to the declaration.
describe('the admin deletion facade use cases of identity, ordering and wallet', () => {
  it.each([
    ['identity.admin-end-customer-sessions', AdminEndCustomerSessions],
    ['ordering.admin-open-obligations-of', AdminOpenObligationsOfQuery],
    ['wallet.admin-balance-of', AdminBalanceOf],
  ] as const)('%s requires exactly customers.buyer-account.delete', (name, useCase) => {
    expect(useCase.access.name).toBe(name);
    expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [BUYER_ACCOUNT_DELETE.key] });
  });
});

// Customers management phase 2: identity's admin rename of a customer declares customers' edit key.
describe('the admin edit facade use case of identity', () => {
  it('identity.admin-rename-customer requires exactly customers.customers.edit', () => {
    expect(AdminRenameCustomer.access.name).toBe('identity.admin-rename-customer');
    expect(AdminRenameCustomer.access.rule).toEqual({
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_EDIT.key],
    });
  });
});

// Customers management phase 2b: the owning modules' exports of one customer's data (the customer
// page's sections) declare customers' protected export key beside their own view key, and spend the
// customers export step-up. Only customers can brand the key, so each module casts the literal; this
// pins every literal to the declaration.
describe('the customer-page exports of the owning modules', () => {
  it('cast exactly the customers export key and its step-up action', () => {
    expect(ORDERING_CUSTOMER_DATA_EXPORT_KEY).toBe(CUSTOMERS_CUSTOMER_EXPORT.key);
    expect(ORDERING_CUSTOMER_DATA_EXPORT_STEP_UP).toBe(CUSTOMERS_EXPORT_STEP_UP);
    expect(AdminCustomerRefundsExport.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['ordering.order.view', CUSTOMERS_CUSTOMER_EXPORT.key],
    });
  });
});
