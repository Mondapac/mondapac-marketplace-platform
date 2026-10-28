import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  AUTHORISATION_CHECK,
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { COMMISSION_PAYOUTS_STEP_UP_ACTIONS } from './contracts/step-up';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { SECURITY_EVENTS } from '../../platform/security-events/security-events';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { SellersModule } from '../sellers';
import type { CommissionPayoutsDependencies } from './application/commission-payouts-dependencies';
import type { DisputeDependencies } from './application/dispute-dependencies';
import type { PayoutDependencies } from './application/payout-dependencies';
import { PAYOUT_CURSOR_REPOSITORY } from './application/ports/payout-cursor.repository';
import {
  PAYMENTS_PAYOUTS,
  PAYOUT_POLICY,
  PAYOUT_PREREQUISITES,
  SELLER_PAYOUT_ACCESS,
} from './application/ports/payout-gateways';
import { PAYOUT_REPOSITORY } from './application/ports/payout.repository';
import { ApplyTransferChange } from './application/use-cases/apply-transfer-change.use-case';
import { ApprovePayout } from './application/use-cases/approve-payout.use-case';
import { ListOwnPayoutHolds } from './application/use-cases/list-own-payout-holds.use-case';
import { ListOwnPayouts } from './application/use-cases/list-own-payouts.use-case';
import { ListPayouts } from './application/use-cases/list-payouts.use-case';
import { ReconcileInstructions } from './application/use-cases/reconcile-instructions.use-case';
import { RunPayouts } from './application/use-cases/run-payouts.use-case';
import { ViewNextPayout } from './application/use-cases/view-next-payout.use-case';
import { ViewPayout } from './application/use-cases/view-payout.use-case';
import { LateBoundPaymentsPayouts } from './infrastructure/late-bound-payments-payouts';
import { AdminPayoutsController, SellerPayoutsController } from './presentation/payout.controller';
import { payoutRunJob, reconcileInstructionsJob } from './presentation/jobs/payout-jobs';
import { DISPUTE_SOURCE, ORDER_PAYMENT_LOOKUP } from './application/ports/dispute-source';
import { DISPUTE_REPOSITORY } from './application/ports/dispute.repository';
import { SELLER_NAMES } from './application/ports/seller-names';
import { DecideDispute } from './application/use-cases/decide-dispute.use-case';
import { ListDisputes } from './application/use-cases/list-disputes.use-case';
import { ListOwnDisputes } from './application/use-cases/list-own-disputes.use-case';
import { SyncDispute } from './application/use-cases/sync-dispute.use-case';
import { ViewDispute } from './application/use-cases/view-dispute.use-case';
import { COMMISSION_PAYOUTS_EVENTS } from './domain/events';
import {
  LateBoundDisputeSource,
  LateBoundOrderPaymentLookup,
} from './infrastructure/late-bound-dispute-ports';
import {
  AdminDisputesController,
  SellerDisputesController,
} from './presentation/dispute.controller';
import { PAYOUT_TERMS_RESOLVER } from './application/payout-terms-resolver';
import { COMMISSION_POLICY } from './application/ports/commission-policy';
import { ELIGIBILITY_ANCHOR_REPOSITORY } from './application/ports/eligibility-anchor.repository';
import { PAYOUT_HOLD_REPOSITORY } from './application/ports/payout-hold.repository';
import { PAYOUT_TERMS_REPOSITORY } from './application/ports/payout-terms.repository';
import { LEDGER_REPOSITORY } from './application/ports/ledger.repository';
import { SELLER_DIRECTORY } from './application/ports/seller-directory';
import { SELLER_RATE_REPOSITORY } from './application/ports/seller-rate.repository';
import { ClearCommissionRate } from './application/use-cases/clear-commission-rate.use-case';
import { ClearSellerPayoutTerms } from './application/use-cases/clear-seller-payout-terms.use-case';
import { CommissionRates } from './application/use-cases/commission-rates.use-case';
import { ListSellerPayoutHolds } from './application/use-cases/list-seller-payout-holds.use-case';
import { NoteSellerReinstated } from './application/use-cases/note-seller-reinstated.use-case';
import { PlacePayoutHold } from './application/use-cases/place-payout-hold.use-case';
import { PlaceSellerSuspendedHold } from './application/use-cases/place-seller-suspended-hold.use-case';
import { RecordRefund } from './application/use-cases/record-refund.use-case';
import { RecordSellerOrderDelivered } from './application/use-cases/record-seller-order-delivered.use-case';
import { RecordSellerOrderPaid } from './application/use-cases/record-seller-order-paid.use-case';
import { ReleasePayoutHold } from './application/use-cases/release-payout-hold.use-case';
import { SetCommissionRate } from './application/use-cases/set-commission-rate.use-case';
import { SetSellerPayoutTerms } from './application/use-cases/set-seller-payout-terms.use-case';
import { ViewCommissionRate } from './application/use-cases/view-commission-rate.use-case';
import { ViewSellerPayoutTerms } from './application/use-cases/view-seller-payout-terms.use-case';
import { ViewOwnLedger } from './application/use-cases/view-own-ledger.use-case';
import { ViewSellerLedger } from './application/use-cases/view-seller-ledger.use-case';
import { COMMISSION_PAYOUTS_FACADE, COMMISSION_PAYOUTS_PERMISSIONS } from './contracts';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from './domain/audit';
import { commissionPayoutsProviders } from './infrastructure/commission-payouts-providers';
import {
  AdminCommissionController,
  SellerLedgerController,
} from './presentation/commission-payouts.controller';
import {
  AdminPayoutHoldsController,
  AdminPayoutTermsController,
} from './presentation/payout-terms.controller';
import { sellerAccessSubscriptions } from './presentation/subscribers/seller-access.subscriptions';
import { CommissionPayoutsFacadeImplementation } from './presentation/commission-payouts.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CommissionPayoutsDependencies) => U;

const PORTS: readonly [keyof CommissionPayoutsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['rates', SELLER_RATE_REPOSITORY],
  ['ledger', LEDGER_REPOSITORY],
  ['policy', COMMISSION_POLICY],
  ['termsOverrides', PAYOUT_TERMS_REPOSITORY],
  ['terms', PAYOUT_TERMS_RESOLVER],
  ['anchors', ELIGIBILITY_ANCHOR_REPOSITORY],
  ['holds', PAYOUT_HOLD_REPOSITORY],
  ['sellers', SELLER_DIRECTORY],
  ['cursors', PAYOUT_CURSOR_REPOSITORY],
  ['outbox', OUTBOX_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

type DisputeUseCaseClass<U> = new (gate: UseCaseGate, deps: DisputeDependencies) => U;

/** The ports of the dispute use cases (package 8b); the dependency object is built the same way. */
const DISPUTE_PORTS: readonly [keyof DisputeDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['disputes', DISPUTE_REPOSITORY],
  ['ledger', LEDGER_REPOSITORY],
  ['holds', PAYOUT_HOLD_REPOSITORY],
  ['cursors', PAYOUT_CURSOR_REPOSITORY],
  ['source', DISPUTE_SOURCE],
  ['orders', ORDER_PAYMENT_LOOKUP],
  ['sellerNames', SELLER_NAMES],
  ['outbox', OUTBOX_WRITER],
  ['securityEvents', SECURITY_EVENTS],
  ['authorisation', AUTHORISATION_CHECK],
  ['stepUp', STEP_UP_CONSUMER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

type PayoutUseCaseClass<U> = new (gate: UseCaseGate, deps: PayoutDependencies) => U;

/** The ports of the payout use cases (package 6d); the dependency object is built the same way. */
const PAYOUT_PORTS: readonly [keyof PayoutDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['payouts', PAYOUT_REPOSITORY],
  ['cursors', PAYOUT_CURSOR_REPOSITORY],
  ['ledger', LEDGER_REPOSITORY],
  ['anchors', ELIGIBILITY_ANCHOR_REPOSITORY],
  ['holds', PAYOUT_HOLD_REPOSITORY],
  ['terms', PAYOUT_TERMS_RESOLVER],
  ['policy', COMMISSION_POLICY],
  ['payoutPolicy', PAYOUT_POLICY],
  ['access', SELLER_PAYOUT_ACCESS],
  ['prerequisites', PAYOUT_PREREQUISITES],
  ['payments', PAYMENTS_PAYOUTS],
  ['sellerNames', SELLER_NAMES],
  ['securityEvents', SECURITY_EVENTS],
  ['stepUp', STEP_UP_CONSUMER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

function payoutUseCaseProvider<U>(type: PayoutUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PAYOUT_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PAYOUT_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as PayoutDependencies,
      ),
  };
}

function disputeUseCaseProvider<U>(type: DisputeUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...DISPUTE_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          DISPUTE_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as DisputeDependencies,
      ),
  };
}

/** Every commission-payouts use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as CommissionPayoutsDependencies,
      ),
  };
}

/**
 * Commission-payouts (Phase 5 package 5, speed mode): the platform commission and the seller
 * ledger. The Market rate is Market config (AU 15 %); an admin may set a separate rate per
 * seller. `ordering` reads the rates through `COMMISSION_PAYOUTS_FACADE` at checkout and freezes
 * them on the order lines; its worker sends each paid seller order here, and the insert-only
 * ledger records the sale, the delivery fee and the commission; a succeeded refund sends its facts
 * back here and the ledger records the reversal rows. Package 6b adds the payout terms (Market
 * config, an admin's override per seller), the eligibility anchor of each delivered seller order
 * (ordering sends the delivery facts) and the payout holds (an admin's, and a system hold when
 * identity suspends a seller). Package 6d adds the payout run (the payouts, their approval and
 * their transfers to payments), the reconciliation of those transfers and the payout views. The
 * reads and calls of payments are bound late, like the dispute reads below. Package 8b adds the
 * dispute effects: a snapshot of each payments dispute, a hold on the order's seller orders while
 * it is open, a seller notice, and the admin's decision on who bears a lost chargeback. The
 * consumer's reads of payments and ordering are bound late, by `CommissionPayoutsDisputesModule`
 * (payments reaches this module through ordering, so this module cannot import them).
 */
@Module({
  imports: [IdentityModule, SellersModule],
  controllers: [
    AdminCommissionController,
    SellerLedgerController,
    AdminPayoutTermsController,
    AdminPayoutHoldsController,
    AdminDisputesController,
    SellerDisputesController,
    AdminPayoutsController,
    SellerPayoutsController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('commission-payouts'),
    PersistenceModule.securityEventsFor('commission-payouts'),
    registerEvents('commission-payouts', COMMISSION_PAYOUTS_EVENTS),
    { provide: DISPUTE_SOURCE, useClass: LateBoundDisputeSource },
    { provide: ORDER_PAYMENT_LOOKUP, useClass: LateBoundOrderPaymentLookup },
    { provide: PAYMENTS_PAYOUTS, useClass: LateBoundPaymentsPayouts },
    PersistenceModule.auditWriterFor('commission-payouts'),
    registerAuditActions('commission-payouts', COMMISSION_PAYOUTS_AUDIT_ACTIONS),
    registerPermissions('commission-payouts', COMMISSION_PAYOUTS_PERMISSIONS),
    registerStepUpActions('commission-payouts', COMMISSION_PAYOUTS_STEP_UP_ACTIONS),
    // Package 6b: identity's seller access suspends or reinstates a seller's payouts
    // (commission_payouts.inbox).
    registerSubscriptionsFrom(
      'commission-payouts',
      [PlaceSellerSuspendedHold, NoteSellerReinstated],
      (suspended: PlaceSellerSuspendedHold, reinstated: NoteSellerReinstated) =>
        sellerAccessSubscriptions(suspended, reinstated),
    ),
    ...commissionPayoutsProviders,
    ...[
      CommissionRates,
      RecordSellerOrderPaid,
      RecordRefund,
      RecordSellerOrderDelivered,
      PlaceSellerSuspendedHold,
      NoteSellerReinstated,
      ViewCommissionRate,
      SetCommissionRate,
      ClearCommissionRate,
      ViewSellerPayoutTerms,
      SetSellerPayoutTerms,
      ClearSellerPayoutTerms,
      PlacePayoutHold,
      ReleasePayoutHold,
      ListSellerPayoutHolds,
      ViewSellerLedger,
      ViewOwnLedger,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    ...[SyncDispute, ListDisputes, ViewDispute, DecideDispute, ListOwnDisputes].map((type) =>
      disputeUseCaseProvider(type as DisputeUseCaseClass<unknown>),
    ),
    ...[
      RunPayouts,
      ReconcileInstructions,
      ApplyTransferChange,
      ListPayouts,
      ViewPayout,
      ApprovePayout,
      ViewNextPayout,
      ListOwnPayouts,
      ListOwnPayoutHolds,
    ].map((type) => payoutUseCaseProvider(type as PayoutUseCaseClass<unknown>)),
    // Package 6d: the payout run (every 15 minutes) and the reconciliation of instructed
    // transfers (every 5 minutes), once per Market under the scheduler's advisory lock.
    registerJobsFrom(
      'commission-payouts',
      [RunPayouts, ReconcileInstructions],
      (run: RunPayouts, reconcile: ReconcileInstructions) => [
        payoutRunJob(run),
        reconcileInstructionsJob(reconcile),
      ],
    ),
    {
      provide: COMMISSION_PAYOUTS_FACADE,
      inject: [CommissionRates, RecordSellerOrderPaid, RecordRefund, RecordSellerOrderDelivered],
      useFactory: (
        rates: CommissionRates,
        record: RecordSellerOrderPaid,
        refund: RecordRefund,
        delivered: RecordSellerOrderDelivered,
      ) => new CommissionPayoutsFacadeImplementation(rates, record, refund, delivered),
    },
  ],
  // The dispute pieces are exported for the binding module of the same folder only (they are not
  // part of the module's entry point).
  exports: [
    COMMISSION_PAYOUTS_FACADE,
    SyncDispute,
    DISPUTE_SOURCE,
    ORDER_PAYMENT_LOOKUP,
    ApplyTransferChange,
    PAYMENTS_PAYOUTS,
  ],
})
export class CommissionPayoutsModule {}
