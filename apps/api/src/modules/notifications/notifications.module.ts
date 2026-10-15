import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { MAIL_TRANSPORT } from '../../platform/mail/mail-transport';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CATALOG_FACADE, CatalogModule } from '../catalog';
import { IDENTITY_FACADE, IdentityModule } from '../identity';
import { ORDERING_FACADE, OrderingModule } from '../ordering';
import type { OrderMailDependencies } from './application/order-mail-flow';
import type { NotificationsDependencies } from './application/notifications-dependencies';
import { NOTIFICATIONS_POLICY } from './application/ports/notifications-policy';
import { SUPPORT_CONTACT_REPOSITORY } from './application/ports/support-contact.repository';
import { SendOrderConfirmationMail } from './application/use-cases/send-order-confirmation-mail.use-case';
import { SendSellerNewOrderMail } from './application/use-cases/send-seller-new-order-mail.use-case';
import { SetSupportContact } from './application/use-cases/set-support-contact.use-case';
import { ViewPublicSupportContact } from './application/use-cases/view-public-support-contact.use-case';
import { ViewSupportContact } from './application/use-cases/view-support-contact.use-case';
import { NOTIFICATIONS_PERMISSIONS } from './contracts';
import { NOTIFICATIONS_AUDIT_ACTIONS } from './domain/audit';
import { notificationsProviders } from './infrastructure/notifications-providers';
import { orderMailSubscriptions } from './presentation/subscribers/order-mail.subscriptions';
import { AdminSupportContactController } from './presentation/support-contact.controller';
import { PublicSupportContactController } from './presentation/public-support-contact.controller';

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

/**
 * Notifications (speed mode). So far one setting: the Market's support email address, seeded from
 * Market configuration and changeable by the platform admin; mail and the sign-in screens read it
 * from here later. Phase 6 package 1: the order emails (Q10), sent when `ordering.order-paid.v1`
 * arrives: the customer's "Order confirmation" and the sellers' "New order".
 */
@Module({
  imports: [OrderingModule, CatalogModule, IdentityModule],
  controllers: [AdminSupportContactController, PublicSupportContactController],
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
    registerSubscriptionsFrom(
      'notifications',
      [SendOrderConfirmationMail, SendSellerNewOrderMail],
      (confirmation: SendOrderConfirmationMail, sellerNewOrder: SendSellerNewOrderMail) =>
        orderMailSubscriptions(confirmation, sellerNewOrder),
    ),
  ],
})
export class NotificationsModule {}
