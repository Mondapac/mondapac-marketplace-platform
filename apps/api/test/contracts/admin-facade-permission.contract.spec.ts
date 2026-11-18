import { AdminEndCustomerSessions } from '../../src/modules/identity/application/use-cases/admin-end-customer-sessions.use-case';
import { AdminOpenObligationsOfQuery } from '../../src/modules/ordering/application/use-cases/admin-open-obligations-of.use-case';
import { AdminBalanceOf } from '../../src/modules/wallet/application/use-cases/admin-balance-of.use-case';
import { AdminRenameCustomer } from '../../src/modules/identity/application/use-cases/admin-rename-customer.use-case';
import {
  BUYER_ACCOUNT_DELETE,
  CUSTOMERS_CUSTOMER_EDIT,
  CUSTOMERS_CUSTOMER_EMAIL_CHANGE,
  CUSTOMERS_CUSTOMER_EXPORT,
  CUSTOMERS_CUSTOMER_VIEW,
  CUSTOMERS_GROUPS_MANAGE,
} from '../../src/modules/customers/contracts/permissions';
import {
  CUSTOMER_EMAIL_CHANGE_STEP_UP,
  CUSTOMERS_EXPORT_STEP_UP,
  CUSTOMERS_STEP_UP_ACTIONS,
} from '../../src/modules/customers/contracts/step-up';
import { AdminCancelCustomerEmailChange } from '../../src/modules/identity/application/use-cases/admin-cancel-customer-email-change.use-case';
import { AdminRequestCustomerEmailChange } from '../../src/modules/identity/application/use-cases/admin-request-customer-email-change.use-case';
import { CustomerPendingEmailOf } from '../../src/modules/identity/application/use-cases/customer-pending-email-of.use-case';
import * as SECTION_KEYS from '../../src/modules/customers/application/section-keys';
import { AdminCustomerPasswordReset as CustomersPasswordReset } from '../../src/modules/customers/application/use-cases/admin-customer-password-reset.use-case';
import { AdminCustomerSessions as CustomersSessions } from '../../src/modules/customers/application/use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignInReveal as CustomersSignInReveal } from '../../src/modules/customers/application/use-cases/admin-customer-sign-in-reveal.use-case';
import { AdminCustomerSignInsExport as CustomersSignInsExport } from '../../src/modules/customers/application/use-cases/admin-customer-sign-ins-export.use-case';
import { AdminCustomerSignIns as CustomersSignIns } from '../../src/modules/customers/application/use-cases/admin-customer-sign-ins.use-case';
import { AdminCustomerSignOut as CustomersSignOut } from '../../src/modules/customers/application/use-cases/admin-customer-sign-out.use-case';
import { AdminCustomerAssistantConversationsSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-assistant-conversations-export.use-case';
import { AdminCustomerAssistantConversationsSection } from '../../src/modules/customers/application/use-cases/admin-customer-assistant-conversations.use-case';
import { AdminCustomerBehaviourSection } from '../../src/modules/customers/application/use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerCartAdditionsSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-cart-additions-export.use-case';
import { AdminCustomerCartAdditionsSection } from '../../src/modules/customers/application/use-cases/admin-customer-cart-additions.use-case';
import { AdminCustomerCartRemindersSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-cart-reminders-export.use-case';
import { AdminCustomerCartRemindersSection } from '../../src/modules/customers/application/use-cases/admin-customer-cart-reminders.use-case';
import { AdminCustomerCartSection } from '../../src/modules/customers/application/use-cases/admin-customer-cart.use-case';
import { AdminCustomerConsentHistorySectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-consent-history-export.use-case';
import { AdminCustomerConsentHistorySection } from '../../src/modules/customers/application/use-cases/admin-customer-consent-history.use-case';
import { AdminCustomerConsentSection } from '../../src/modules/customers/application/use-cases/admin-customer-consent.use-case';
import { AdminCustomerSavedItemsSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-saved-items-export.use-case';
import { AdminCustomerSavedItemsSection } from '../../src/modules/customers/application/use-cases/admin-customer-saved-items.use-case';
import { CART_CUSTOMER_CART_VIEW as CART_KEY } from '../../src/modules/cart/contracts/permissions';
import { AdminCustomerCartRead as CartCustomerCart } from '../../src/modules/cart/application/use-cases/admin-customer-cart.use-case';
import { AdminCustomerSavedItems as CartSavedItems } from '../../src/modules/cart/application/use-cases/admin-customer-saved-items.use-case';
import { NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW as REMINDERS_KEY } from '../../src/modules/notifications/contracts/permissions';
import { AdminCustomerCartReminders as NotificationsCartReminders } from '../../src/modules/notifications/application/use-cases/admin-customer-cart-reminders.use-case';
import { ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW as BEHAVIOUR_KEY } from '../../src/modules/engagement/contracts/permissions';
import { AdminCustomerBehaviour as EngagementBehaviour } from '../../src/modules/engagement/application/use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerCartAdditions as EngagementCartAdditions } from '../../src/modules/engagement/application/use-cases/admin-customer-cart-additions.use-case';
import { LEGAL_CUSTOMER_CONSENT_VIEW as CONSENT_KEY } from '../../src/modules/legal/contracts/permissions';
import { AdminCustomerConsent as LegalConsent } from '../../src/modules/legal/application/use-cases/admin-customer-consent.use-case';
import { AdminCustomerConsentHistory as LegalConsentHistory } from '../../src/modules/legal/application/use-cases/admin-customer-consent-history.use-case';
import { ASSISTANT_CUSTOMER_CONVERSATION_VIEW as CONVERSATIONS_KEY } from '../../src/modules/assistant/contracts/permissions';
import { AdminCustomerConversations as AssistantConversations } from '../../src/modules/assistant/application/use-cases/admin-customer-conversations.use-case';
import { AdminCustomerReviewsSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-reviews-export.use-case';
import { AdminCustomerReviewsSection } from '../../src/modules/customers/application/use-cases/admin-customer-reviews.use-case';
import { CustomerReviewEventsCheck } from '../../src/modules/customers/application/use-cases/customer-review-events-check.use-case';
import { AdminCustomerSellerRatingsSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-seller-ratings-export.use-case';
import { AdminCustomerSellerRatingsSection } from '../../src/modules/customers/application/use-cases/admin-customer-seller-ratings.use-case';
import { AdminCustomerHelpfulVotesSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-helpful-votes-export.use-case';
import { AdminCustomerHelpfulVotesSection } from '../../src/modules/customers/application/use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerReviewReportsSectionExport } from '../../src/modules/customers/application/use-cases/admin-customer-review-reports-export.use-case';
import { AdminCustomerReviewReportsSection } from '../../src/modules/customers/application/use-cases/admin-customer-review-reports.use-case';
import {
  SECTION_REPORT_ROLES,
  SECTION_REVIEW_STATUSES,
  SECTION_SELLER_RATING_STATUSES,
} from '../../src/modules/customers/application/ports/customer-section-peers';
import { REVIEWS_CUSTOMER_REVIEW_VIEW as REVIEWS_KEY } from '../../src/modules/reviews/contracts/permissions';
import { REVIEW_STATUSES, SELLER_RATING_STATUSES } from '../../src/modules/reviews/domain/rules';
import { AdminCustomerHelpfulVotes as ReviewsHelpfulVotes } from '../../src/modules/reviews/application/use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerReviewReports as ReviewsReports } from '../../src/modules/reviews/application/use-cases/admin-customer-review-reports.use-case';
import { AdminCustomerReviews as ReviewsReviews } from '../../src/modules/reviews/application/use-cases/admin-customer-reviews.use-case';
import { AdminCustomerSellerRatings as ReviewsSellerRatings } from '../../src/modules/reviews/application/use-cases/admin-customer-seller-ratings.use-case';
import { ReviewAuthorOf } from '../../src/modules/reviews/application/use-cases/review-author-of.use-case';
import * as IDENTITY_KEYS from '../../src/modules/identity/contracts/permissions';
import { AdminCustomerSessions as IdentityCustomerSessions } from '../../src/modules/identity/application/use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignIns as IdentityCustomerSignIns } from '../../src/modules/identity/application/use-cases/admin-customer-sign-ins.use-case';
import { AdminRevealCustomerSignIn as IdentityRevealCustomerSignIn } from '../../src/modules/identity/application/use-cases/admin-reveal-customer-sign-in.use-case';
import { AdminSendCustomerPasswordReset as IdentitySendCustomerPasswordReset } from '../../src/modules/identity/application/use-cases/admin-send-customer-password-reset.use-case';
import { AdminSignOutCustomer as IdentitySignOutCustomer } from '../../src/modules/identity/application/use-cases/admin-sign-out-customer.use-case';
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
import {
  CUSTOMER_DATA_VIEW_KEY as PROMOTIONS_CUSTOMER_DATA_VIEW_KEY,
  ListCustomerPromotionUsages,
} from '../../src/modules/promotions/application/use-cases/list-customer-promotion-usages.use-case';
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
    expect(PROMOTIONS_CUSTOMER_DATA_VIEW_KEY).toBe(CUSTOMERS_CUSTOMER_VIEW.key);
  });

  it.each([
    ['ordering.admin-customer-refunds-list', AdminCustomerRefundsList, 'ordering.order.view'],
    [
      'payments.admin-customer-payments',
      PaymentsAdminCustomerPayments,
      PAYMENTS_CUSTOMER_PAYMENT_VIEW.key,
    ],
    ['payments.admin-customer-disputes', AdminCustomerDisputes, PAYMENTS_CUSTOMER_PAYMENT_VIEW.key],
    [
      'promotions.list-customer-promotion-usages',
      ListCustomerPromotionUsages,
      'promotions.promotion.view',
    ],
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
    expect([
      SECTION_KEYS.CART_CUSTOMER_CART_VIEW,
      SECTION_KEYS.NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW,
      SECTION_KEYS.ENGAGEMENT_CUSTOMER_BEHAVIOUR_VIEW,
      SECTION_KEYS.LEGAL_CUSTOMER_CONSENT_VIEW,
      SECTION_KEYS.ASSISTANT_CUSTOMER_CONVERSATION_VIEW,
      SECTION_KEYS.REVIEWS_CUSTOMER_REVIEW_VIEW,
    ]).toEqual([
      CART_KEY.key,
      REMINDERS_KEY.key,
      BEHAVIOUR_KEY.key,
      CONSENT_KEY.key,
      CONVERSATIONS_KEY.key,
      REVIEWS_KEY.key,
    ]);
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
    [AdminCustomerCartSection, [VIEW, CART_KEY.key]],
    [AdminCustomerSavedItemsSection, [VIEW, CART_KEY.key]],
    [AdminCustomerSavedItemsSectionExport, [VIEW, CART_KEY.key, EXPORT]],
    [AdminCustomerCartRemindersSection, [VIEW, REMINDERS_KEY.key]],
    [AdminCustomerCartRemindersSectionExport, [VIEW, REMINDERS_KEY.key, EXPORT]],
    [AdminCustomerBehaviourSection, [VIEW, BEHAVIOUR_KEY.key]],
    [AdminCustomerCartAdditionsSection, [VIEW, BEHAVIOUR_KEY.key]],
    [AdminCustomerCartAdditionsSectionExport, [VIEW, BEHAVIOUR_KEY.key, EXPORT]],
    [AdminCustomerConsentSection, [VIEW, CONSENT_KEY.key]],
    [AdminCustomerConsentHistorySection, [VIEW, CONSENT_KEY.key]],
    [AdminCustomerConsentHistorySectionExport, [VIEW, CONSENT_KEY.key, EXPORT]],
    [AdminCustomerAssistantConversationsSection, [VIEW, CONVERSATIONS_KEY.key]],
    [AdminCustomerAssistantConversationsSectionExport, [VIEW, CONVERSATIONS_KEY.key, EXPORT]],
    [AdminCustomerReviewsSection, [VIEW, REVIEWS_KEY.key]],
    [AdminCustomerReviewsSectionExport, [VIEW, REVIEWS_KEY.key, EXPORT]],
    [AdminCustomerSellerRatingsSection, [VIEW, REVIEWS_KEY.key]],
    [AdminCustomerSellerRatingsSectionExport, [VIEW, REVIEWS_KEY.key, EXPORT]],
    [AdminCustomerHelpfulVotesSection, [VIEW, REVIEWS_KEY.key]],
    [AdminCustomerHelpfulVotesSectionExport, [VIEW, REVIEWS_KEY.key, EXPORT]],
    [AdminCustomerReviewReportsSection, [VIEW, REVIEWS_KEY.key]],
    [AdminCustomerReviewReportsSectionExport, [VIEW, REVIEWS_KEY.key, EXPORT]],
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
    [CartCustomerCart, [CART_KEY.key]],
    [CartSavedItems, [CART_KEY.key]],
    [NotificationsCartReminders, [REMINDERS_KEY.key]],
    [EngagementBehaviour, [BEHAVIOUR_KEY.key]],
    [EngagementCartAdditions, [BEHAVIOUR_KEY.key]],
    [LegalConsent, [CONSENT_KEY.key]],
    [LegalConsentHistory, [CONSENT_KEY.key]],
    [AssistantConversations, [CONVERSATIONS_KEY.key]],
    [ReviewsReviews, [REVIEWS_KEY.key]],
    [ReviewsSellerRatings, [REVIEWS_KEY.key]],
    [ReviewsHelpfulVotes, [REVIEWS_KEY.key]],
    [ReviewsReports, [REVIEWS_KEY.key]],
  ] as const)('the owner’s facade read %p declares its own key', (useCase, keys) => {
    expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: keys });
  });

  it('keeps the owners’ new view keys plain (not protected)', () => {
    for (const key of [
      CART_KEY,
      REMINDERS_KEY,
      BEHAVIOUR_KEY,
      CONSENT_KEY,
      CONVERSATIONS_KEY,
      REVIEWS_KEY,
    ]) {
      expect(key.protected).toBe(false);
    }
  });

  // Part 3: reviews. The key is a platform key (never a seller's: a seller must not tie a review to
  // a buyer); the author lookup the timeline uses is the system's only; customers mirrors reviews'
  // closed status lists (it cannot import reviews) and this pins them.
  it('keeps reviews’ customer key a platform key and the author lookup the system’s', () => {
    expect(REVIEWS_KEY.scope).toBe('platform');
    expect(ReviewAuthorOf.access.rule).toEqual({ kind: 'system' });
    // The timeline shows the review kinds only to a caller who holds reviews' key (L1).
    expect(CustomerReviewEventsCheck.access.rule).toEqual({
      kind: 'permissions',
      allOf: [REVIEWS_KEY.key],
    });
    expect([...SECTION_REVIEW_STATUSES]).toEqual([...REVIEW_STATUSES]);
    expect([...SECTION_SELLER_RATING_STATUSES]).toEqual([...SELLER_RATING_STATUSES]);
    expect([...SECTION_REPORT_ROLES]).toEqual(['by', 'about']);
  });
});
