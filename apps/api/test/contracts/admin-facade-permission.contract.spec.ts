import { AdminEndCustomerSessions } from '../../src/modules/identity/application/use-cases/admin-end-customer-sessions.use-case';
import { AdminOpenObligationsOfQuery } from '../../src/modules/ordering/application/use-cases/admin-open-obligations-of.use-case';
import { AdminBalanceOf } from '../../src/modules/wallet/application/use-cases/admin-balance-of.use-case';
import { AdminRenameCustomer } from '../../src/modules/identity/application/use-cases/admin-rename-customer.use-case';
import {
  BUYER_ACCOUNT_DELETE,
  CUSTOMERS_CUSTOMER_EDIT,
  CUSTOMERS_CUSTOMER_EXPORT,
  CUSTOMERS_CUSTOMER_VIEW,
  CUSTOMERS_GROUPS_MANAGE,
} from '../../src/modules/customers/contracts/permissions';
import * as SECTION_KEYS from '../../src/modules/customers/application/section-keys';
import { AdminCustomerPasswordReset as CustomersPasswordReset } from '../../src/modules/customers/application/use-cases/admin-customer-password-reset.use-case';
import { AdminCustomerSessions as CustomersSessions } from '../../src/modules/customers/application/use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignInReveal as CustomersSignInReveal } from '../../src/modules/customers/application/use-cases/admin-customer-sign-in-reveal.use-case';
import { AdminCustomerSignInsExport as CustomersSignInsExport } from '../../src/modules/customers/application/use-cases/admin-customer-sign-ins-export.use-case';
import { AdminCustomerSignIns as CustomersSignIns } from '../../src/modules/customers/application/use-cases/admin-customer-sign-ins.use-case';
import { AdminCustomerSignOut as CustomersSignOut } from '../../src/modules/customers/application/use-cases/admin-customer-sign-out.use-case';
import * as IDENTITY_KEYS from '../../src/modules/identity/contracts/permissions';
import { AdminCustomerSessions as IdentityCustomerSessions } from '../../src/modules/identity/application/use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignIns as IdentityCustomerSignIns } from '../../src/modules/identity/application/use-cases/admin-customer-sign-ins.use-case';
import { AdminRevealCustomerSignIn as IdentityRevealCustomerSignIn } from '../../src/modules/identity/application/use-cases/admin-reveal-customer-sign-in.use-case';
import { AdminSendCustomerPasswordReset as IdentitySendCustomerPasswordReset } from '../../src/modules/identity/application/use-cases/admin-send-customer-password-reset.use-case';
import { AdminSignOutCustomer as IdentitySignOutCustomer } from '../../src/modules/identity/application/use-cases/admin-sign-out-customer.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../../src/modules/customers/contracts/step-up';
import {
  CUSTOMER_DATA_EXPORT_KEY as ORDERING_CUSTOMER_DATA_EXPORT_KEY,
  CUSTOMER_DATA_EXPORT_STEP_UP as ORDERING_CUSTOMER_DATA_EXPORT_STEP_UP,
  CUSTOMER_DATA_VIEW_KEY as ORDERING_CUSTOMER_DATA_VIEW_KEY,
} from '../../src/modules/ordering/application/customer-refunds-list-flow';
import { AdminCustomerRefundsExport } from '../../src/modules/ordering/application/use-cases/admin-customer-refunds-export.use-case';
import { AdminCustomerRefundsList } from '../../src/modules/ordering/application/use-cases/admin-customer-refunds-list.use-case';
import { AdminCustomerOrderIds } from '../../src/modules/ordering/application/use-cases/admin-customer-order-ids.use-case';
import { AdminCustomerPayments as OrderingAdminCustomerPayments } from '../../src/modules/ordering/application/use-cases/admin-customer-payments.use-case';
import {
  CUSTOMER_DATA_EXPORT_KEY as PAYMENTS_CUSTOMER_DATA_EXPORT_KEY,
  CUSTOMER_DATA_EXPORT_STEP_UP as PAYMENTS_CUSTOMER_DATA_EXPORT_STEP_UP,
  CUSTOMER_DATA_VIEW_KEY as PAYMENTS_CUSTOMER_DATA_VIEW_KEY,
} from '../../src/modules/payments/application/customer-payments-flow';
import { AdminCustomerDisputesExport } from '../../src/modules/payments/application/use-cases/admin-customer-disputes-export.use-case';
import { AdminCustomerDisputes } from '../../src/modules/payments/application/use-cases/admin-customer-disputes.use-case';
import { AdminCustomerPaymentsExport } from '../../src/modules/payments/application/use-cases/admin-customer-payments-export.use-case';
import { AdminCustomerPayments as PaymentsAdminCustomerPayments } from '../../src/modules/payments/application/use-cases/admin-customer-payments.use-case';
import { PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../../src/modules/payments/contracts/permissions';
import {
  CountGroupSegmentUses,
  CUSTOMERS_GROUPS_MANAGE_KEY,
} from '../../src/modules/promotions/application/use-cases/count-group-segment-uses.use-case';

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
      allOf: ['ordering.order.view', CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_CUSTOMER_EXPORT.key],
    });
  });
});

// Customers management phase 2b (Hassan, Low): every tab of the customer page needs customers' view
// key, so the owning modules' customer-scoped reads and exports declare it beside their own key.
// Only customers can brand the key, so each module casts the literal; this pins every literal to
// the declaration and every rule to the pair.
describe('the customer-page reads of the owning modules', () => {
  it('cast exactly the customers view key', () => {
    expect(ORDERING_CUSTOMER_DATA_VIEW_KEY).toBe(CUSTOMERS_CUSTOMER_VIEW.key);
    expect(PAYMENTS_CUSTOMER_DATA_VIEW_KEY).toBe(CUSTOMERS_CUSTOMER_VIEW.key);
  });

  it.each([
    ['ordering.admin-customer-refunds-list', AdminCustomerRefundsList, 'ordering.order.view'],
    [
      'payments.admin-customer-payments',
      PaymentsAdminCustomerPayments,
      PAYMENTS_CUSTOMER_PAYMENT_VIEW.key,
    ],
    ['payments.admin-customer-disputes', AdminCustomerDisputes, PAYMENTS_CUSTOMER_PAYMENT_VIEW.key],
  ] as const)('%s requires its own view key and customers.customers.view', (name, useCase, own) => {
    expect(useCase.access).toEqual({
      name,
      rule: { kind: 'permissions', allOf: [own, CUSTOMERS_CUSTOMER_VIEW.key] },
    });
  });

  it.each([
    ['payments.admin-customer-payments-export', AdminCustomerPaymentsExport],
    ['payments.admin-customer-disputes-export', AdminCustomerDisputesExport],
  ] as const)('%s also requires customers.customers.view and the export key', (name, useCase) => {
    expect(useCase.access).toEqual({
      name,
      rule: {
        kind: 'permissions',
        allOf: [
          PAYMENTS_CUSTOMER_PAYMENT_VIEW.key,
          CUSTOMERS_CUSTOMER_VIEW.key,
          CUSTOMERS_CUSTOMER_EXPORT.key,
        ],
      },
    });
  });
});

// Customers management phase 2b: ordering's facade reads behind payments' customer page lists
// declare the key payments declared, so an admin without it reaches no payment fact through them.
describe('the payment facade use cases of ordering', () => {
  it.each([
    ['ordering.admin-customer-payments', OrderingAdminCustomerPayments],
    ['ordering.admin-customer-order-ids', AdminCustomerOrderIds],
  ] as const)('%s requires exactly payments.customer-payment.view', (name, useCase) => {
    expect(useCase.access.name).toBe(name);
    expect(useCase.access.rule).toEqual({
      kind: 'permissions',
      allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key],
    });
  });

  it('payments casts exactly the customers export key and its step-up action', () => {
    expect(PAYMENTS_CUSTOMER_DATA_EXPORT_KEY).toBe(CUSTOMERS_CUSTOMER_EXPORT.key);
    expect(PAYMENTS_CUSTOMER_DATA_EXPORT_STEP_UP).toBe(CUSTOMERS_EXPORT_STEP_UP);
  });
});

// Customers management phase 2b: the count of live promotions that name a manual customer group
// (the archive warning) is asked under the archive's own key, which promotions casts.
describe('the group segment count of promotions', () => {
  it('requires exactly customers.groups.manage', () => {
    expect(CUSTOMERS_GROUPS_MANAGE_KEY).toBe(CUSTOMERS_GROUPS_MANAGE.key);
    expect(CountGroupSegmentUses.access).toEqual({
      name: 'promotions.count-group-segment-uses',
      rule: { kind: 'permissions', allOf: [CUSTOMERS_GROUPS_MANAGE.key] },
    });
  });
});

// Customers management phase 2b, part 2: the customer page's sections other modules own. Each
// customers use case declares customers.customers.view plus the owner's key (and the export adds
// the protected customers.customers.export); the owner's facade use case declares the owner's key.
// customers casts the owners' literals (section-keys.ts); this pins each to its declaration.
describe('the customer page sections and their owners’ facade reads', () => {
  const VIEW = CUSTOMERS_CUSTOMER_VIEW.key;
  const EXPORT = CUSTOMERS_CUSTOMER_EXPORT.key;

  it('casts exactly the keys the owners declared', () => {
    expect([
      SECTION_KEYS.IDENTITY_CUSTOMER_SIGN_IN_VIEW,
      SECTION_KEYS.IDENTITY_CUSTOMER_SIGN_IN_REVEAL,
      SECTION_KEYS.IDENTITY_CUSTOMER_SESSION_END,
      SECTION_KEYS.IDENTITY_CUSTOMER_PASSWORD_RESET_SEND,
    ]).toEqual([
      IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key,
      IDENTITY_KEYS.CUSTOMER_SIGN_IN_REVEAL.key,
      IDENTITY_KEYS.CUSTOMER_SESSION_END.key,
      IDENTITY_KEYS.CUSTOMER_PASSWORD_RESET_SEND.key,
    ]);
    expect(IDENTITY_KEYS.CUSTOMER_SIGN_IN_REVEAL.protected).toBe(true);
  });

  it.each([
    [CustomersSignIns, [VIEW, IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key]],
    [CustomersSignInsExport, [VIEW, IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key, EXPORT]],
    [
      CustomersSignInReveal,
      [VIEW, IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key, IDENTITY_KEYS.CUSTOMER_SIGN_IN_REVEAL.key],
    ],
    [CustomersSessions, [VIEW, IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key]],
    [CustomersSignOut, [VIEW, IDENTITY_KEYS.CUSTOMER_SESSION_END.key]],
    [CustomersPasswordReset, [VIEW, IDENTITY_KEYS.CUSTOMER_PASSWORD_RESET_SEND.key]],
  ] as const)('%p requires customers view plus the owner’s key', (useCase, keys) => {
    expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: keys });
  });

  it.each([
    [IdentityCustomerSignIns, [IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key]],
    [IdentityCustomerSessions, [IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key]],
    [
      IdentityRevealCustomerSignIn,
      [IDENTITY_KEYS.CUSTOMER_SIGN_IN_VIEW.key, IDENTITY_KEYS.CUSTOMER_SIGN_IN_REVEAL.key],
    ],
    [IdentitySignOutCustomer, [IDENTITY_KEYS.CUSTOMER_SESSION_END.key]],
    [IdentitySendCustomerPasswordReset, [IDENTITY_KEYS.CUSTOMER_PASSWORD_RESET_SEND.key]],
  ] as const)('the owner’s facade read %p declares its own key', (useCase, keys) => {
    expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: keys });
  });
});
