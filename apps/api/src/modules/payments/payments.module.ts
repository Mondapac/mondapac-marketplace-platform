import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { SECURITY_EVENTS } from '../../platform/security-events/security-events';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IDENTITY_FACADE, IdentityModule } from '../identity';
import { ORDERING_FACADE, OrderingModule } from '../ordering';
import type { PaymentsDependencies } from './application/payments-dependencies';
import { CONNECTED_ACCOUNT_STORE } from './application/ports/connected-account-store';
import { CONNECT_GATEWAY } from './application/ports/connect-gateway';
import { DISPUTE_STORE } from './application/ports/dispute-store';
import { PAYMENTS_POLICY } from './application/ports/payments-policy';
import { STRIPE_DISPUTE_READER } from './application/ports/stripe-dispute-reader';
import { STRIPE_EVENT_INBOX } from './application/ports/stripe-event-inbox';
import { STRIPE_SESSION_READER } from './application/ports/stripe-session-reader';
import { STRIPE_SIGNATURE } from './application/ports/stripe-signature';
import { AdminListConnectedAccounts } from './application/use-cases/admin-list-connected-accounts.use-case';
import { AdminViewConnectedAccount } from './application/use-cases/admin-view-connected-account.use-case';
import { ApplyStripeEvents } from './application/use-cases/apply-stripe-events.use-case';
import { ConnectPayoutAccount } from './application/use-cases/connect-payout-account.use-case';
import { DisputeOfQuery } from './application/use-cases/dispute-of.use-case';
import { OpenPayoutAccountLink } from './application/use-cases/open-payout-account-link.use-case';
import { PayoutReadinessQuery } from './application/use-cases/payout-readiness.use-case';
import { SyncPayoutSchedules } from './application/use-cases/sync-payout-schedules.use-case';
import { ViewPayoutAccount } from './application/use-cases/view-payout-account.use-case';
import { ReceiveStripeEvent } from './application/use-cases/receive-stripe-event.use-case';
import { PAYMENTS_FACADE } from './contracts';
import { PAYMENTS_PERMISSIONS } from './contracts/permissions';
import { PAYMENTS_STEP_UP_ACTIONS } from './contracts/step-up';
import { PAYMENTS_AUDIT_ACTIONS } from './domain/audit';
import { PAYMENTS_EVENTS } from './domain/events';
import { paymentsProviders } from './infrastructure/payments-providers';
import { syncPayoutSchedulesJob } from './presentation/jobs/sync-payout-schedules.job';
import { applyStripeEventsJob } from './presentation/jobs/apply-stripe-events.job';
import { AdminConnectedAccountsController } from './presentation/admin-connected-accounts.controller';
import { PaymentsFacadeImplementation } from './presentation/payments.facade';
import { SellerPayoutAccountController } from './presentation/seller-payout-account.controller';
import { StripeWebhookController } from './presentation/stripe-webhook.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: PaymentsDependencies) => U;

const PORTS: readonly [keyof PaymentsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['inbox', STRIPE_EVENT_INBOX],
  ['signature', STRIPE_SIGNATURE],
  ['reader', STRIPE_SESSION_READER],
  ['disputeReader', STRIPE_DISPUTE_READER],
  ['disputes', DISPUTE_STORE],
  ['outbox', OUTBOX_WRITER],
  ['ordering', ORDERING_FACADE],
  ['accounts', CONNECTED_ACCOUNT_STORE],
  ['connect', CONNECT_GATEWAY],
  ['policy', PAYMENTS_POLICY],
  ['identity', IDENTITY_FACADE],
  ['audit', AUDIT_WRITER],
  ['securityEvents', SECURITY_EVENTS],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** Every payments use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as PaymentsDependencies,
      ),
  };
}

/**
 * Payments (Phase 5, speed mode). Package 2: the Stripe webhook receiver. The endpoint verifies
 * and stores each event once; the worker job re-reads the session from Stripe and applies it
 * through `ORDERING_FACADE` as the system actor. Package 3: the seller's Stripe Connect Express
 * payout account (create, hosted onboarding page, state from account events) and the
 * `PAYMENTS_FACADE` readiness answer for payouts. The leftovers of package 3: a bank change starts
 * a waiting period that pauses Stripe payouts (one job writes the schedule), changing the payout
 * account needs a recent two-step code from identity, and an admin can read the accounts. Package
 * 8a: dispute events are stored like the Checkout events, the worker records each dispute in
 * `payments.disputes` and publishes `payments.dispute-changed.v1`; `disputeOf` reads them. Test
 * mode only.
 */
@Module({
  imports: [OrderingModule, IdentityModule],
  controllers: [
    StripeWebhookController,
    SellerPayoutAccountController,
    AdminConnectedAccountsController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('payments'),
    PersistenceModule.securityEventsFor('payments'),
    PersistenceModule.outboxWriterFor('payments'),
    registerEvents('payments', PAYMENTS_EVENTS),
    registerAuditActions('payments', PAYMENTS_AUDIT_ACTIONS),
    registerPermissions('payments', PAYMENTS_PERMISSIONS),
    registerStepUpActions('payments', PAYMENTS_STEP_UP_ACTIONS),
    ...paymentsProviders,
    useCaseProvider(ReceiveStripeEvent),
    useCaseProvider(ApplyStripeEvents),
    useCaseProvider(ConnectPayoutAccount),
    useCaseProvider(OpenPayoutAccountLink),
    useCaseProvider(ViewPayoutAccount),
    useCaseProvider(PayoutReadinessQuery),
    useCaseProvider(DisputeOfQuery),
    useCaseProvider(SyncPayoutSchedules),
    useCaseProvider(AdminListConnectedAccounts),
    useCaseProvider(AdminViewConnectedAccount),
    {
      provide: PAYMENTS_FACADE,
      inject: [PayoutReadinessQuery, DisputeOfQuery],
      useFactory: (readiness: PayoutReadinessQuery, disputes: DisputeOfQuery) =>
        new PaymentsFacadeImplementation(readiness, disputes),
    },
    registerJobsFrom(
      'payments',
      [ApplyStripeEvents, SyncPayoutSchedules],
      (apply: ApplyStripeEvents, sync: SyncPayoutSchedules) => [
        applyStripeEventsJob(apply),
        syncPayoutSchedulesJob(sync),
      ],
    ),
  ],
  exports: [PAYMENTS_FACADE],
})
export class PaymentsModule {}
