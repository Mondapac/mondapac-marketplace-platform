import { Module } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { CATALOG_FACADE, CatalogModule, type CatalogFacade } from '../catalog';
import {
  COMMISSION_PAYOUTS_REPORTING_FACADE,
  CommissionPayoutsModule,
  type CommissionPayoutsReportingFacade,
} from '../commission-payouts';
import { LedgerRecorder } from './application/ledger-recorder';
import type {
  LedgerBackfillDependencies,
  LedgerFactsDependencies,
} from './application/ledger-facts-sync';
import type { LedgerKpiDependencies } from './application/ledger-kpi-flow';
import { LEDGER_KPI_READER, type LedgerKpiReader } from './application/ports/ledger-kpi-reader';
import { LEDGER_SOURCES, type LedgerSources } from './application/ports/ledger-sources';
import { BackfillLedger } from './application/use-cases/backfill-ledger.use-case';
import { RecordLedgerFacts } from './application/use-cases/record-ledger-facts.use-case';
import { ViewMarketplaceNetRevenue } from './application/use-cases/view-marketplace-net-revenue.use-case';
import { ViewSellerNetEarnings } from './application/use-cases/view-seller-net-earnings.use-case';
import { FacadeLedgerSources } from './infrastructure/facade-ledger-sources';
import { backfillLedgerJob } from './presentation/jobs/backfill-ledger.job';
import { ledgerFactsSubscriptions } from './presentation/subscribers/ledger-facts.subscriptions';
import {
  ORDERING_REPORTING_FACADE,
  OrderingModule,
  type OrderingReportingFacade,
} from '../ordering';
import type { AdminKpiDependencies } from './application/admin-kpi-flow';
import type { BackfillDependencies } from './application/backfill-history';
import { FactRecorder } from './application/fact-recorder';
import { ADMIN_KPI_READER, type AdminKpiReader } from './application/ports/admin-kpi-reader';
import {
  BACKFILL_PROGRESS_STORE,
  type BackfillProgressStore,
} from './application/ports/backfill-progress-store';
import { MARKET_ZONE, type MarketZone } from './application/ports/market-zone';
import { REPORT_SOURCES, type ReportSources } from './application/ports/report-sources';
import type { ReportFactsDependencies } from './application/report-facts-sync';
import { ViewMarketplaceFinanceKpis } from './application/use-cases/view-marketplace-finance-kpis.use-case';
import { ViewMarketplaceTopCategories } from './application/use-cases/view-marketplace-top-categories.use-case';
import { ViewMarketplaceTopSellers } from './application/use-cases/view-marketplace-top-sellers.use-case';
import { ViewMarketplaceOperationsKpis } from './application/use-cases/view-marketplace-operations-kpis.use-case';
import { ViewMarketplaceOrderStatus } from './application/use-cases/view-marketplace-order-status.use-case';
import { BackfillHistory } from './application/use-cases/backfill-history.use-case';
import { ReconcileReportFacts } from './application/use-cases/reconcile-report-facts.use-case';
import { RecordReportFacts } from './application/use-cases/record-report-facts.use-case';
import { SELLER_KPI_READER, type SellerKpiReader } from './application/ports/seller-kpi-reader';
import {
  ViewSellerKpis,
  type ViewSellerKpisDependencies,
} from './application/use-cases/view-seller-kpis.use-case';
import { REPORTING_KPI_FACADE } from './contracts';
import { FacadeReportSources } from './infrastructure/facade-report-sources';
import { reportingProviders } from './infrastructure/reporting-providers';
import { ReportingKpiFacadeImplementation } from './presentation/reporting-kpi.facade';
import { backfillHistoryJob } from './presentation/jobs/backfill-history.job';
import { SellerKpisController } from './presentation/seller-kpis.controller';
import { reconcileReportFactsJob } from './presentation/jobs/reconcile-report-facts.job';
import { reportFactsSubscriptions } from './presentation/subscribers/report-facts.subscriptions';

const REPORT_FACTS_DEPENDENCIES = Symbol('REPORT_FACTS_DEPENDENCIES');
const ADMIN_KPI_DEPENDENCIES = Symbol('ADMIN_KPI_DEPENDENCIES');
const LEDGER_FACTS_DEPENDENCIES = Symbol('LEDGER_FACTS_DEPENDENCIES');
const LEDGER_KPI_DEPENDENCIES = Symbol('LEDGER_KPI_DEPENDENCIES');

/**
 * The reporting module (dashboards upgrade, option B, phase 3): the facts behind the dashboard
 * numbers and their daily rollups. It reads no table of another module: the facts come from
 * ordering's reporting facade and catalog's `offerPrimaryCategories`, through the event worker
 * (ordering's order and refund events) and the nightly reconcile; the ledger facts come from
 * commission-payouts' reporting facade (its `ledger-recorded` event and the ledger backfill). No module imports it. It
 * publishes no event and holds no permission yet (the KPI reads of phases 5 and 6 add them). The history backfill job brings
 * the facts recorded before the module was deployed in, once.
 */
@Module({
  imports: [PersistenceModule, OrderingModule, CatalogModule, CommissionPayoutsModule],
  controllers: [SellerKpisController],
  providers: [
    ...reportingProviders,
    {
      provide: ViewSellerKpis,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, SELLER_KPI_READER, MARKET_ZONE, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        reader: SellerKpiReader,
        zone: MarketZone,
        clock: Clock,
      ) =>
        new ViewSellerKpis(gate, {
          unitOfWork,
          reader,
          zone,
          clock,
        } satisfies ViewSellerKpisDependencies),
    },
    {
      provide: REPORT_SOURCES,
      inject: [ORDERING_REPORTING_FACADE, CATALOG_FACADE],
      useFactory: (ordering: OrderingReportingFacade, catalog: CatalogFacade): ReportSources =>
        new FacadeReportSources(ordering, catalog),
    },
    {
      provide: REPORT_FACTS_DEPENDENCIES,
      inject: [UNIT_OF_WORK, REPORT_SOURCES, FactRecorder, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        sources: ReportSources,
        recorder: FactRecorder,
        clock: Clock,
      ): ReportFactsDependencies => ({ unitOfWork, sources, recorder, clock }),
    },
    {
      provide: RecordReportFacts,
      inject: [USE_CASE_GATE, REPORT_FACTS_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: ReportFactsDependencies) =>
        new RecordReportFacts(gate, deps),
    },
    {
      provide: ReconcileReportFacts,
      inject: [USE_CASE_GATE, REPORT_FACTS_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: ReportFactsDependencies) =>
        new ReconcileReportFacts(gate, deps),
    },
    {
      provide: BackfillHistory,
      inject: [USE_CASE_GATE, REPORT_FACTS_DEPENDENCIES, BACKFILL_PROGRESS_STORE],
      useFactory: (
        gate: UseCaseGate,
        deps: ReportFactsDependencies,
        progress: BackfillProgressStore,
      ) => new BackfillHistory(gate, { ...deps, progress } satisfies BackfillDependencies),
    },
    {
      provide: ADMIN_KPI_DEPENDENCIES,
      inject: [UNIT_OF_WORK, ADMIN_KPI_READER, MARKET_ZONE, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        reader: AdminKpiReader,
        zone: MarketZone,
        clock: Clock,
      ): AdminKpiDependencies => ({ unitOfWork, reader, zone, clock }),
    },
    {
      provide: ViewMarketplaceFinanceKpis,
      inject: [USE_CASE_GATE, ADMIN_KPI_DEPENDENCIES, LEDGER_KPI_READER],
      useFactory: (gate: UseCaseGate, deps: AdminKpiDependencies, ledger: LedgerKpiReader) =>
        new ViewMarketplaceFinanceKpis(gate, { ...deps, ledger }),
    },
    ...[
      ViewMarketplaceOperationsKpis,
      ViewMarketplaceOrderStatus,
      ViewMarketplaceTopSellers,
      ViewMarketplaceTopCategories,
    ].map((type) => ({
      provide: type,
      inject: [USE_CASE_GATE, ADMIN_KPI_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: AdminKpiDependencies) => new type(gate, deps),
    })),
    // The ledger facts (dashboards v2, phase 1, PR 4).
    {
      provide: LEDGER_SOURCES,
      inject: [COMMISSION_PAYOUTS_REPORTING_FACADE],
      useFactory: (ledger: CommissionPayoutsReportingFacade): LedgerSources =>
        new FacadeLedgerSources(ledger),
    },
    {
      provide: LEDGER_FACTS_DEPENDENCIES,
      inject: [UNIT_OF_WORK, LEDGER_SOURCES, LedgerRecorder, CLOCK, BACKFILL_PROGRESS_STORE],
      useFactory: (
        unitOfWork: UnitOfWork,
        sources: LedgerSources,
        recorder: LedgerRecorder,
        clock: Clock,
        progress: BackfillProgressStore,
      ): LedgerBackfillDependencies => ({ unitOfWork, sources, recorder, clock, progress }),
    },
    {
      provide: RecordLedgerFacts,
      inject: [USE_CASE_GATE, LEDGER_FACTS_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: LedgerFactsDependencies) =>
        new RecordLedgerFacts(gate, deps),
    },
    {
      provide: BackfillLedger,
      inject: [USE_CASE_GATE, LEDGER_FACTS_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: LedgerBackfillDependencies) =>
        new BackfillLedger(gate, deps),
    },
    {
      provide: LEDGER_KPI_DEPENDENCIES,
      inject: [UNIT_OF_WORK, LEDGER_KPI_READER, MARKET_ZONE, CLOCK],
      useFactory: (
        unitOfWork: UnitOfWork,
        reader: LedgerKpiReader,
        zone: MarketZone,
        clock: Clock,
      ): LedgerKpiDependencies => ({ unitOfWork, reader, zone, clock }),
    },
    ...[ViewMarketplaceNetRevenue, ViewSellerNetEarnings].map((type) => ({
      provide: type,
      inject: [USE_CASE_GATE, LEDGER_KPI_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: LedgerKpiDependencies) => new type(gate, deps),
    })),
    {
      provide: REPORTING_KPI_FACADE,
      inject: [
        ViewMarketplaceOperationsKpis,
        ViewMarketplaceFinanceKpis,
        ViewMarketplaceTopSellers,
        ViewMarketplaceTopCategories,
        ViewMarketplaceNetRevenue,
        ViewSellerNetEarnings,
        ViewMarketplaceOrderStatus,
      ],
      useFactory: (
        operations: ViewMarketplaceOperationsKpis,
        finance: ViewMarketplaceFinanceKpis,
        topSellers: ViewMarketplaceTopSellers,
        topCategories: ViewMarketplaceTopCategories,
        netRevenue: ViewMarketplaceNetRevenue,
        netEarnings: ViewSellerNetEarnings,
        orderStatus: ViewMarketplaceOrderStatus,
      ) =>
        new ReportingKpiFacadeImplementation(
          operations,
          finance,
          topSellers,
          topCategories,
          netRevenue,
          netEarnings,
          orderStatus,
        ),
    },
    registerSubscriptionsFrom(
      'reporting',
      [RecordReportFacts, RecordLedgerFacts],
      (record: RecordReportFacts, ledger: RecordLedgerFacts) => [
        ...reportFactsSubscriptions(record),
        ...ledgerFactsSubscriptions(ledger),
      ],
    ),
    registerJobsFrom(
      'reporting',
      [ReconcileReportFacts, BackfillHistory, BackfillLedger],
      (reconcile: ReconcileReportFacts, backfill: BackfillHistory, ledger: BackfillLedger) => [
        reconcileReportFactsJob(reconcile),
        backfillHistoryJob(backfill),
        backfillLedgerJob(ledger),
      ],
    ),
  ],
  exports: [REPORTING_KPI_FACADE],
})
export class ReportingModule {}
