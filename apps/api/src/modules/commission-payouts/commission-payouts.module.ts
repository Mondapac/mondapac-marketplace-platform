import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { COMMISSION_PAYOUTS_STEP_UP_ACTIONS } from './contracts/step-up';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import type { CommissionPayoutsDependencies } from './application/commission-payouts-dependencies';
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
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

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
 * identity suspends a seller). No money moves: the payout run is package 6d.
 */
@Module({
  imports: [SellersModule],
  controllers: [
    AdminCommissionController,
    SellerLedgerController,
    AdminPayoutTermsController,
    AdminPayoutHoldsController,
  ],
  providers: [
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
  exports: [COMMISSION_PAYOUTS_FACADE],
})
export class CommissionPayoutsModule {}
