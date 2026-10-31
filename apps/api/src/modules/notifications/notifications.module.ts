import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  AUTHORISATION_CHECK,
  registerPermissions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { MAIL_TRANSPORT } from '../../platform/mail/mail-transport';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CART_REMINDER_FACADE, CartModule } from '../cart';
import { CATALOG_FACADE, CatalogModule } from '../catalog';
import { IDENTITY_FACADE, IdentityModule } from '../identity';
import { LEGAL_FACADE, LegalModule } from '../legal';
import { ORDERING_FACADE, OrderingModule } from '../ordering';
import type { MarketingDependencies } from './application/marketing-mail-flow';
import type { InAppNoticeDependencies } from './application/in-app-notice-flow';
import type { OrderMailDependencies } from './application/order-mail-flow';
import type { NotificationsDependencies } from './application/notifications-dependencies';
import { CART_REMINDER_REPOSITORY } from './application/ports/cart-reminder.repository';
import { IN_APP_NOTICE_REPOSITORY } from './application/ports/in-app-notice.repository';
import { NOTIFICATIONS_POLICY } from './application/ports/notifications-policy';
import { SUPPORT_CONTACT_REPOSITORY } from './application/ports/support-contact.repository';
import { UNSUBSCRIBE_TOKENS } from './application/ports/unsubscribe-tokens';
import { CountOwnUnreadNotices } from './application/use-cases/count-own-unread-notices.use-case';
import { ListOwnNotices } from './application/use-cases/list-own-notices.use-case';
import { MarkOwnNoticesRead } from './application/use-cases/mark-own-notices-read.use-case';
import { PurgeExpiredNotices } from './application/use-cases/purge-expired-notices.use-case';
import { RecordAdminReviewNotice } from './application/use-cases/record-admin-review-notice.use-case';
import { RecordSellerNotice } from './application/use-cases/record-seller-notice.use-case';
import { RecordSellerOrderNotices } from './application/use-cases/record-seller-order-notices.use-case';
import {
  SendCartReminders,
  type CartReminderDependencies,
} from './application/use-cases/send-cart-reminders.use-case';
import { SendOrderConfirmationMail } from './application/use-cases/send-order-confirmation-mail.use-case';
import { SendOrderShippedMail } from './application/use-cases/send-order-shipped-mail.use-case';
import { SendSellerNewOrderMail } from './application/use-cases/send-seller-new-order-mail.use-case';
import { SendSellerOrderDisputedMail } from './application/use-cases/send-seller-order-disputed-mail.use-case';
import { disputeNoticeSubscriptions } from './presentation/subscribers/dispute-notice.subscriptions';
import { SetSupportContact } from './application/use-cases/set-support-contact.use-case';
import { UnsubscribeMarketingEmail } from './application/use-cases/unsubscribe-marketing-email.use-case';
import { ViewPublicSupportContact } from './application/use-cases/view-public-support-contact.use-case';
import { SUPPORT_CONTACT_FACADE } from './contracts/support-contact.facade';
import { SupportContactFacadeImplementation } from './presentation/support-contact.facade';
import { ViewSupportContact } from './application/use-cases/view-support-contact.use-case';
import { ViewUnsubscribeLink } from './application/use-cases/view-unsubscribe-link.use-case';
import { NOTIFICATIONS_PERMISSIONS } from './contracts';
import { NOTIFICATIONS_AUDIT_ACTIONS } from './domain/audit';
import { notificationsProviders } from './infrastructure/notifications-providers';
import { AdminNoticesController } from './presentation/admin-notices.controller';
import { purgeExpiredNoticesJob } from './presentation/jobs/purge-expired-notices.job';
import { sendCartRemindersJob } from './presentation/jobs/send-cart-reminders.job';
import { SellerNoticesController } from './presentation/seller-notices.controller';
import { payoutNoticeSubscriptions } from './presentation/subscribers/payout-notice.subscriptions';
import { inAppNoticeSubscriptions } from './presentation/subscribers/in-app-notice.subscriptions';
import { orderMailSubscriptions } from './presentation/subscribers/order-mail.subscriptions';
import { AdminSupportContactController } from './presentation/support-contact.controller';
import { PublicSupportContactController } from './presentation/public-support-contact.controller';
import { UnsubscribeController } from './presentation/unsubscribe.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: NotificationsDependencies) => U;

const PORTS: readonly [keyof NotificationsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['contacts', SUPPORT_CONTACT_REPOSITORY],
  ['policy', NOTIFICATIONS_POLICY],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
];

/** Every notifications use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as NotificationsDependencies,
      ),
  };
}

const ORDER_MAIL_PORTS: readonly [keyof OrderMailDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['ordering', ORDERING_FACADE],
  ['catalog', CATALOG_FACADE],
  ['identity', IDENTITY_FACADE],
  ['transport', MAIL_TRANSPORT],
  ['policy', NOTIFICATIONS_POLICY],
];

/** The order mail use cases share one dependency object (facades, transport and policy). */
function orderMailProvider<U>(
  type: new (gate: UseCaseGate, deps: OrderMailDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...ORDER_MAIL_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          ORDER_MAIL_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as OrderMailDependencies,
      ),
  };
}

const MARKETING_PORTS: readonly [keyof MarketingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['contacts', SUPPORT_CONTACT_REPOSITORY],
  ['legal', LEGAL_FACADE],
  ['identity', IDENTITY_FACADE],
  ['transport', MAIL_TRANSPORT],
  ['policy', NOTIFICATIONS_POLICY],
  ['tokens', UNSUBSCRIBE_TOKENS],
];

/** The marketing use cases (unsubscribe link) share one dependency object. */
function marketingProvider<U>(
  type: new (gate: UseCaseGate, deps: MarketingDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...MARKETING_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          MARKETING_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as MarketingDependencies,
      ),
  };
}

const CART_REMINDER_PORTS: readonly [keyof CartReminderDependencies, InjectionToken][] = [
  ...MARKETING_PORTS,
  ['carts', CART_REMINDER_FACADE],
  ['reminders', CART_REMINDER_REPOSITORY],
  ['clock', CLOCK],
];

/** The cart reminder (personalization 1c): the marketing ports plus cart, its record and the clock. */
const cartReminderProvider: FactoryProvider<SendCartReminders> = {
  provide: SendCartReminders,
  inject: [USE_CASE_GATE, ...CART_REMINDER_PORTS.map(([, token]) => token)],
  useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
    new SendCartReminders(
      gate,
      Object.fromEntries(
        CART_REMINDER_PORTS.map(([name], index) => [name, values[index]]),
      ) as unknown as CartReminderDependencies,
    ),
};

const IN_APP_NOTICE_PORTS: readonly [keyof InAppNoticeDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['notices', IN_APP_NOTICE_REPOSITORY],
  ['ordering', ORDERING_FACADE],
  ['catalog', CATALOG_FACADE],
  ['authorisation', AUTHORISATION_CHECK],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** The in-app notice use cases share one dependency object. */
function inAppNoticeProvider<U>(
  type: new (gate: UseCaseGate, deps: InAppNoticeDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...IN_APP_NOTICE_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          IN_APP_NOTICE_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as InAppNoticeDependencies,
      ),
  };
}

/**
 * Notifications (speed mode). So far one setting: the Market's support email address, seeded from
 * Market configuration and changeable by the platform admin; mail and the sign-in screens read it
 * from here later. Phase 6 package 1: the order emails (Q10), sent when `ordering.order-paid.v1`
 * arrives: the customer's "Order confirmation" and the sellers' "New order". In-app notices
 * (package 1): the sellers' "New order" notice under the panel bell, read per member, kept 90 days;
 * (package 3) the admins' review notices (certificate, product revision, seller file, held price);
 * (package 4) the sellers' other notices (stock, certificates, catalog, prices, access).
 * Personalization 1b: the marketing mail rule (consent from `legal`, sender, contact and
 * unsubscribe link) and the one-click unsubscribe route. Personalization 1c: the abandoned-cart
 * email (the job `notifications.cart-reminders`, a marketing mail at about 4 and 24 hours idle).
 */
@Module({
  imports: [OrderingModule, CatalogModule, IdentityModule, LegalModule, CartModule],
  controllers: [
    AdminNoticesController,
    AdminSupportContactController,
    PublicSupportContactController,
    SellerNoticesController,
    UnsubscribeController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('notifications'),
    registerAuditActions('notifications', NOTIFICATIONS_AUDIT_ACTIONS),
    registerPermissions('notifications', NOTIFICATIONS_PERMISSIONS),
    ...notificationsProviders,
    ...[SetSupportContact, ViewSupportContact, ViewPublicSupportContact].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
    orderMailProvider(SendOrderConfirmationMail),
    orderMailProvider(SendSellerNewOrderMail),
    orderMailProvider(SendOrderShippedMail),
    orderMailProvider(SendSellerOrderDisputedMail),
    marketingProvider(ViewUnsubscribeLink),
    marketingProvider(UnsubscribeMarketingEmail),
    cartReminderProvider,
    ...[
      RecordSellerOrderNotices,
      RecordAdminReviewNotice,
      RecordSellerNotice,
      ListOwnNotices,
      CountOwnUnreadNotices,
      MarkOwnNoticesRead,
      PurgeExpiredNotices,
    ].map((type) =>
      inAppNoticeProvider(
        type as new (gate: UseCaseGate, deps: InAppNoticeDependencies) => unknown,
      ),
    ),
    registerSubscriptionsFrom(
      'notifications',
      [SendOrderConfirmationMail, SendSellerNewOrderMail, SendOrderShippedMail],
      (
        confirmation: SendOrderConfirmationMail,
        sellerNewOrder: SendSellerNewOrderMail,
        shipped: SendOrderShippedMail,
      ) => orderMailSubscriptions(confirmation, sellerNewOrder, shipped),
    ),
    registerSubscriptionsFrom(
      'notifications',
      [RecordSellerOrderNotices, RecordAdminReviewNotice, RecordSellerNotice],
      (
        sellerOrders: RecordSellerOrderNotices,
        adminReviews: RecordAdminReviewNotice,
        sellerNotices: RecordSellerNotice,
      ) => inAppNoticeSubscriptions(sellerOrders, adminReviews, sellerNotices),
    ),
    // Package 8b: a disputed payment puts a seller order on hold (D8).
    registerSubscriptionsFrom(
      'notifications',
      [RecordSellerNotice, SendSellerOrderDisputedMail],
      (notice: RecordSellerNotice, mail: SendSellerOrderDisputedMail) =>
        disputeNoticeSubscriptions(notice, mail),
    ),
    // Package 6d: a change of payout terms, a reinstated seller whose payouts stay on hold.
    registerSubscriptionsFrom(
      'notifications',
      [RecordSellerNotice, RecordAdminReviewNotice],
      (sellerNotice: RecordSellerNotice, adminNotice: RecordAdminReviewNotice) =>
        payoutNoticeSubscriptions(sellerNotice, adminNotice),
    ),
    registerJobsFrom(
      'notifications',
      [PurgeExpiredNotices, SendCartReminders],
      (purge: PurgeExpiredNotices, cartReminders: SendCartReminders) => [
        purgeExpiredNoticesJob(purge),
        sendCartRemindersJob(cartReminders),
      ],
    ),
    {
      provide: SUPPORT_CONTACT_FACADE,
      inject: [ViewPublicSupportContact],
      useFactory: (view: ViewPublicSupportContact) => new SupportContactFacadeImplementation(view),
    },
  ],
  exports: [SUPPORT_CONTACT_FACADE],
})
export class NotificationsModule {}
