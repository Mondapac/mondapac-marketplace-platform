import { CountFailedWebhooks } from './application/use-cases/count-failed-webhooks.use-case';
import { CountRestrictedAccounts } from './application/use-cases/count-restricted-accounts.use-case';
import {
  PAYMENTS_WORK_QUEUE_COUNT_READER,
  type PaymentsWorkQueueCountReader,
} from './application/ports/work-queue-count.reader';
import { PaymentsWorkQueueFacadeImplementation } from './presentation/payments-work-queue.facade';
import { PAYMENTS_WORK_QUEUE_FACADE } from './contracts/payments-work-queue.facade';
import type { UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { AdminCustomerPaymentsController } from './presentation/admin-customer-payments.controller';
import { AdminCustomerDisputesExport } from './application/use-cases/admin-customer-disputes-export.use-case';
import { AdminCustomerDisputes } from './application/use-cases/admin-customer-disputes.use-case';
import { AdminCustomerPaymentsExport } from './application/use-cases/admin-customer-payments-export.use-case';
import { AdminCustomerPayments } from './application/use-cases/admin-customer-payments.use-case';
import type { CustomerPaymentsDependencies } from './application/customer-payments-flow';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../platform/list-export';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
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
import { EXTERNAL_ACCOUNT_KEYRING } from './application/ports/external-account-keyring';
import { PAYMENTS_POLICY } from './application/ports/payments-policy';
import { STRIPE_DISPUTE_READER } from './application/ports/stripe-dispute-reader';
import { STRIPE_EVENT_INBOX } from './application/ports/stripe-event-inbox';
import { STRIPE_SESSION_READER } from './application/ports/stripe-session-reader';
import { STRIPE_SIGNATURE } from './application/ports/stripe-signature';
import { STRIPE_TRANSFER_GATEWAY } from './application/ports/transfer-gateway';
import { TRANSFER_STORE } from './application/ports/transfer-store';
import { AbandonTransfer } from './application/use-cases/abandon-transfer.use-case';
import type { AdminAccountListDependencies } from './application/admin-account-list-flow';
import { CONNECTED_ACCOUNT_LIST_READER } from './application/ports/connected-account-list.reader';
import { SELLER_NAMES } from './application/ports/seller-names';
import { AdminExportConnectedAccounts } from './application/use-cases/admin-export-connected-accounts.use-case';
import { AdminListConnectedAccounts } from './application/use-cases/admin-list-connected-accounts.use-case';
import { SellersModule } from '../sellers';
import { AdminViewConnectedAccount } from './application/use-cases/admin-view-connected-account.use-case';
import { ApplyStripeEvents } from './application/use-cases/apply-stripe-events.use-case';
import { ConnectPayoutAccount } from './application/use-cases/connect-payout-account.use-case';
import { DisputeOfQuery } from './application/use-cases/dispute-of.use-case';
import { InstructTransfer } from './application/use-cases/instruct-transfer.use-case';
import { DisputesOfOrderQuery } from './application/use-cases/disputes-of-order.use-case';
import { OpenPayoutAccountLink } from './application/use-cases/open-payout-account-link.use-case';
import { PayoutReadinessQuery } from './application/use-cases/payout-readiness.use-case';
import { ResolveTransfers } from './application/use-cases/resolve-transfers.use-case';
import { SyncPayoutSchedules } from './application/use-cases/sync-payout-schedules.use-case';
import { TransferByKeyQuery } from './application/use-cases/transfer-by-key.use-case';
import { ViewPayoutAccount } from './application/use-cases/view-payout-account.use-case';
import { ReceiveStripeEvent } from './application/use-cases/receive-stripe-event.use-case';
import { PAYMENTS_FACADE } from './contracts';
import { PAYMENTS_PERMISSIONS } from './contracts/permissions';
import { PAYMENTS_STEP_UP_ACTIONS } from './contracts/step-up';
import { PAYMENTS_AUDIT_ACTIONS } from './domain/audit';
import { PAYMENTS_EVENTS } from './domain/events';
import { paymentsProviders } from './infrastructure/payments-providers';
import { resolveTransfersJob } from './presentation/jobs/resolve-transfers.job';
import { syncPayoutSchedulesJob } from './presentation/jobs/sync-payout-schedules.job';
import { applyStripeEventsJob } from './presentation/jobs/apply-stripe-events.job';
import { AdminConnectedAccountsController } from './presentation/admin-connected-accounts.controller';
import { PaymentsFacadeImplementation } from './presentation/payments.facade';
import { SellerPayoutAccountController } from './presentation/seller-payout-account.controller';
import { StripeWebhookController } from './presentation/stripe-webhook.controller';
import { ListsModule, registerLists } from '../lists';
import { PAYMENTS_LISTS } from './application/saved-filters/list-definitions';

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
  ['transfers', TRANSFER_STORE],
  ['transferGateway', STRIPE_TRANSFER_GATEWAY],
  ['keyring', EXTERNAL_ACCOUNT_KEYRING],
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

type ListUseCaseClass<U> = new (gate: UseCaseGate, deps: AdminAccountListDependencies) => U;

const LIST_PORTS: readonly [keyof AdminAccountListDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['list', CONNECTED_ACCOUNT_LIST_READER],
  ['sellerNames', SELLER_NAMES],
  ['sheetWriter', SHEET_WRITER],
  ['clock', CLOCK],
];

/** The admin Seller accounts list (super list 22) and its export: read only, their own ports. */
function listUseCaseProvider<U>(type: ListUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...LIST_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          LIST_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as AdminAccountListDependencies,
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
 * `payments.disputes` and publishes `payments.dispute-changed.v1`; `disputeOf` reads them.
 * Package 6c: `instructTransfer`, `transferByKey` and `abandonTransfer` send a transfer to a
 * seller's connected account once, behind the live check of the account's hash; the resolve job
 * and the transfer webhooks record what Stripe created; `payments.transfer-changed.v1` tells the
 * outcome. Test mode only.
 */
@Module({
  imports: [OrderingModule, IdentityModule, ListsModule, SellersModule],
  controllers: [
    StripeWebhookController,
    SellerPayoutAccountController,
    AdminConnectedAccountsController,
    AdminCustomerPaymentsController,
  ],
  providers: [
    ...[CountFailedWebhooks, CountRestrictedAccounts].map((type) => ({
      provide: type,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, PAYMENTS_WORK_QUEUE_COUNT_READER],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        counts: PaymentsWorkQueueCountReader,
      ) => new type(gate, { unitOfWork, counts }),
    })),
    {
      provide: PAYMENTS_WORK_QUEUE_FACADE,
      inject: [CountFailedWebhooks, CountRestrictedAccounts],
      useFactory: (
        failedWebhooks: CountFailedWebhooks,
        restrictedAccounts: CountRestrictedAccounts,
      ) => new PaymentsWorkQueueFacadeImplementation(failedWebhooks, restrictedAccounts),
    },
    PersistenceModule.auditWriterFor('payments'),
    PersistenceModule.securityEventsFor('payments'),
    PersistenceModule.outboxWriterFor('payments'),
    registerEvents('payments', PAYMENTS_EVENTS),
    registerAuditActions('payments', PAYMENTS_AUDIT_ACTIONS),
    registerPermissions('payments', PAYMENTS_PERMISSIONS),
    registerLists('payments', PAYMENTS_LISTS),
    registerStepUpActions('payments', PAYMENTS_STEP_UP_ACTIONS),
    ...paymentsProviders,
    useCaseProvider(ReceiveStripeEvent),
    useCaseProvider(ApplyStripeEvents),
    useCaseProvider(ConnectPayoutAccount),
    useCaseProvider(OpenPayoutAccountLink),
    useCaseProvider(ViewPayoutAccount),
    useCaseProvider(PayoutReadinessQuery),
    useCaseProvider(DisputeOfQuery),
    useCaseProvider(InstructTransfer),
    useCaseProvider(TransferByKeyQuery),
    useCaseProvider(AbandonTransfer),
    useCaseProvider(ResolveTransfers),
    useCaseProvider(DisputesOfOrderQuery),
    useCaseProvider(SyncPayoutSchedules),
    listUseCaseProvider(AdminListConnectedAccounts),
    listUseCaseProvider(AdminExportConnectedAccounts),
    useCaseProvider(AdminViewConnectedAccount),
    { provide: SHEET_WRITER, useFactory: (): SheetWriter => new ExceljsSheetWriter() },
    ...[
      AdminCustomerPayments,
      AdminCustomerPaymentsExport,
      AdminCustomerDisputes,
      AdminCustomerDisputesExport,
    ].map((type): FactoryProvider => ({
      provide: type,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        ORDERING_FACADE,
        DISPUTE_STORE,
        AUDIT_WRITER,
        STEP_UP_CONSUMER,
        SHEET_WRITER,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: CustomerPaymentsDependencies['unitOfWork'],
        ordering: CustomerPaymentsDependencies['ordering'],
        disputes: CustomerPaymentsDependencies['disputes'],
        audit: CustomerPaymentsDependencies['audit'],
        stepUp: CustomerPaymentsDependencies['stepUp'],
        sheetWriter: CustomerPaymentsDependencies['sheetWriter'],
        clock: CustomerPaymentsDependencies['clock'],
      ) => new type(gate, { unitOfWork, ordering, disputes, audit, stepUp, sheetWriter, clock }),
    })),
    {
      provide: PAYMENTS_FACADE,
      inject: [
        PayoutReadinessQuery,
        DisputeOfQuery,
        InstructTransfer,
        TransferByKeyQuery,
        AbandonTransfer,
        DisputesOfOrderQuery,
      ],
      useFactory: (
        readiness: PayoutReadinessQuery,
        disputes: DisputeOfQuery,
        instruct: InstructTransfer,
        byKey: TransferByKeyQuery,
        abandon: AbandonTransfer,
        orderDisputes: DisputesOfOrderQuery,
      ) =>
        new PaymentsFacadeImplementation(
          readiness,
          disputes,
          instruct,
          byKey,
          abandon,
          orderDisputes,
        ),
    },
    registerJobsFrom(
      'payments',
      [ApplyStripeEvents, SyncPayoutSchedules, ResolveTransfers],
      (apply: ApplyStripeEvents, sync: SyncPayoutSchedules, resolve: ResolveTransfers) => [
        applyStripeEventsJob(apply),
        syncPayoutSchedulesJob(sync),
        resolveTransfersJob(resolve),
      ],
    ),
  ],
  exports: [PAYMENTS_FACADE, PAYMENTS_WORK_QUEUE_FACADE],
})
export class PaymentsModule {}
