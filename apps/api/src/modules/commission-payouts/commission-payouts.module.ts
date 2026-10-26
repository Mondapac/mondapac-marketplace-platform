import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import type { CommissionPayoutsDependencies } from './application/commission-payouts-dependencies';
import { COMMISSION_POLICY } from './application/ports/commission-policy';
import { LEDGER_REPOSITORY } from './application/ports/ledger.repository';
import { SELLER_DIRECTORY } from './application/ports/seller-directory';
import { SELLER_RATE_REPOSITORY } from './application/ports/seller-rate.repository';
import { ClearCommissionRate } from './application/use-cases/clear-commission-rate.use-case';
import { CommissionRates } from './application/use-cases/commission-rates.use-case';
import { RecordRefund } from './application/use-cases/record-refund.use-case';
import { RecordSellerOrderPaid } from './application/use-cases/record-seller-order-paid.use-case';
import { SetCommissionRate } from './application/use-cases/set-commission-rate.use-case';
import { ViewCommissionRate } from './application/use-cases/view-commission-rate.use-case';
import { ViewOwnLedger } from './application/use-cases/view-own-ledger.use-case';
import { ViewSellerLedger } from './application/use-cases/view-seller-ledger.use-case';
import { COMMISSION_PAYOUTS_FACADE, COMMISSION_PAYOUTS_PERMISSIONS } from './contracts';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from './domain/audit';
import { commissionPayoutsProviders } from './infrastructure/commission-payouts-providers';
import {
  AdminCommissionController,
  SellerLedgerController,
} from './presentation/commission-payouts.controller';
import { CommissionPayoutsFacadeImplementation } from './presentation/commission-payouts.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CommissionPayoutsDependencies) => U;

const PORTS: readonly [keyof CommissionPayoutsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['rates', SELLER_RATE_REPOSITORY],
  ['ledger', LEDGER_REPOSITORY],
  ['policy', COMMISSION_POLICY],
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
 * back here and the ledger records the reversal rows. No money moves: payouts are
 * package 6.
 */
@Module({
  imports: [SellersModule],
  controllers: [AdminCommissionController, SellerLedgerController],
  providers: [
    PersistenceModule.auditWriterFor('commission-payouts'),
    registerAuditActions('commission-payouts', COMMISSION_PAYOUTS_AUDIT_ACTIONS),
    registerPermissions('commission-payouts', COMMISSION_PAYOUTS_PERMISSIONS),
    ...commissionPayoutsProviders,
    ...[
      CommissionRates,
      RecordSellerOrderPaid,
      RecordRefund,
      ViewCommissionRate,
      SetCommissionRate,
      ClearCommissionRate,
      ViewSellerLedger,
      ViewOwnLedger,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: COMMISSION_PAYOUTS_FACADE,
      inject: [CommissionRates, RecordSellerOrderPaid, RecordRefund],
      useFactory: (rates: CommissionRates, record: RecordSellerOrderPaid, refund: RecordRefund) =>
        new CommissionPayoutsFacadeImplementation(rates, record, refund),
    },
  ],
  exports: [COMMISSION_PAYOUTS_FACADE],
})
export class CommissionPayoutsModule {}
