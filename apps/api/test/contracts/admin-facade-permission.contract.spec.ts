import { AdminEndCustomerSessions } from '../../src/modules/identity/application/use-cases/admin-end-customer-sessions.use-case';
import { AdminOpenObligationsOfQuery } from '../../src/modules/ordering/application/use-cases/admin-open-obligations-of.use-case';
import { AdminBalanceOf } from '../../src/modules/wallet/application/use-cases/admin-balance-of.use-case';
import { AdminRenameCustomer } from '../../src/modules/identity/application/use-cases/admin-rename-customer.use-case';
import {
  BUYER_ACCOUNT_DELETE,
  CUSTOMERS_CUSTOMER_EDIT,
  CUSTOMERS_CUSTOMER_EMAIL_CHANGE,
  CUSTOMERS_CUSTOMER_VIEW,
} from '../../src/modules/customers/contracts/permissions';
import {
  CUSTOMER_EMAIL_CHANGE_STEP_UP,
  CUSTOMERS_STEP_UP_ACTIONS,
} from '../../src/modules/customers/contracts/step-up';
import { AdminCancelCustomerEmailChange } from '../../src/modules/identity/application/use-cases/admin-cancel-customer-email-change.use-case';
import { AdminRequestCustomerEmailChange } from '../../src/modules/identity/application/use-cases/admin-request-customer-email-change.use-case';
import { CustomerPendingEmailOf } from '../../src/modules/identity/application/use-cases/customer-pending-email-of.use-case';

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

// Hassan R4 (customers admin email change): identity's request and cancel run under customers'
// protected key, checked again in identity's own unit; the customer page's pending read runs under
// customers' view key. The literals are cast in identity; this pins them to customers' declarations.
describe('the admin email change use cases of identity', () => {
  it.each([
    ['identity.admin-request-customer-email-change', AdminRequestCustomerEmailChange],
    ['identity.admin-cancel-customer-email-change', AdminCancelCustomerEmailChange],
  ] as const)('%s requires exactly customers.customer-email.change', (name, useCase) => {
    expect(useCase.access.name).toBe(name);
    expect(useCase.access.rule).toEqual({
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_EMAIL_CHANGE.key],
    });
    expect(CUSTOMERS_CUSTOMER_EMAIL_CHANGE.protected).toBe(true);
  });

  it('identity.customer-pending-email-of requires exactly customers.customers.view', () => {
    expect(CustomerPendingEmailOf.access.name).toBe('identity.customer-pending-email-of');
    expect(CustomerPendingEmailOf.access.rule).toEqual({
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key],
    });
  });

  it('the step-up action is the change key, required by default and locked', () => {
    expect(CUSTOMER_EMAIL_CHANGE_STEP_UP).toBe(CUSTOMERS_CUSTOMER_EMAIL_CHANGE.key);
    expect(
      CUSTOMERS_STEP_UP_ACTIONS.find((action) => action.key === CUSTOMER_EMAIL_CHANGE_STEP_UP),
    ).toMatchObject({ defaultRequired: true, locked: true, audience: 'admin' });
  });
});
