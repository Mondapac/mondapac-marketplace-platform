import { Module } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER, type AuditWriter } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../platform/list-export';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { CATALOG_FACADE, CatalogModule, type CatalogFacade } from '../catalog';
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
import { BackfillHistory } from './application/use-cases/backfill-history.use-case';
import { ReconcileReportFacts } from './application/use-cases/reconcile-report-facts.use-case';
import { RecordReportFacts } from './application/use-cases/record-report-facts.use-case';
import { SELLER_KPI_READER, type SellerKpiReader } from './application/ports/seller-kpi-reader';
import {
  ViewSellerKpis,
  type ViewSellerKpisDependencies,
} from './application/use-cases/view-seller-kpis.use-case';
import { ExportMarketplaceDaily } from './application/use-cases/export-marketplace-daily.use-case';
import { ExportSellerDaily } from './application/use-cases/export-seller-daily.use-case';
import { REPORTING_KPI_FACADE } from './contracts';
import { REPORTING_PERMISSIONS } from './contracts/permissions';
import { REPORTING_AUDIT_ACTIONS } from './domain/audit';
import { AdminReportsController } from './presentation/admin-reports.controller';
import { FacadeReportSources } from './infrastructure/facade-report-sources';
import { reportingProviders } from './infrastructure/reporting-providers';
import { ReportingKpiFacadeImplementation } from './presentation/reporting-kpi.facade';
import { backfillHistoryJob } from './presentation/jobs/backfill-history.job';
import { SellerKpisController } from './presentation/seller-kpis.controller';
import { reconcileReportFactsJob } from './presentation/jobs/reconcile-report-facts.job';
import { reportFactsSubscriptions } from './presentation/subscribers/report-facts.subscriptions';

const REPORT_FACTS_DEPENDENCIES = Symbol('REPORT_FACTS_DEPENDENCIES');
const ADMIN_KPI_DEPENDENCIES = Symbol('ADMIN_KPI_DEPENDENCIES');

/**
 * The reporting module (dashboards upgrade, option B, phase 3): the facts behind the dashboard
 * numbers and their daily rollups. It reads no table of another module: the facts come from
 * ordering's reporting facade and catalog's `offerPrimaryCategories`, through the event worker
 * (ordering's order and refund events) and the nightly reconcile. No module imports it. It
 * publishes no event. Its own keys are the two daily exports' (dashboards v2, PR 5), each audited.
 * The history backfill job brings the facts recorded before the module was deployed in, once.
 */
@Module({
  imports: [PersistenceModule, OrderingModule, CatalogModule],
  controllers: [SellerKpisController, AdminReportsController],
  providers: [
    ...reportingProviders,
    PersistenceModule.auditWriterFor('reporting'),
    registerAuditActions('reporting', REPORTING_AUDIT_ACTIONS),
    registerPermissions('reporting', REPORTING_PERMISSIONS),
    { provide: SHEET_WRITER, useFactory: (): SheetWriter => new ExceljsSheetWriter() },
    {
      provide: ExportSellerDaily,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        SELLER_KPI_READER,
        MARKET_ZONE,
        CLOCK,
        AUDIT_WRITER,
        SHEET_WRITER,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        reader: SellerKpiReader,
        zone: MarketZone,
        clock: Clock,
        audit: AuditWriter,
        sheetWriter: SheetWriter,
      ) => new ExportSellerDaily(gate, { unitOfWork, reader, zone, clock, audit, sheetWriter }),
    },
    {
      provide: ExportMarketplaceDaily,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        ADMIN_KPI_READER,
        MARKET_ZONE,
        CLOCK,
        AUDIT_WRITER,
        SHEET_WRITER,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: UnitOfWork,
        reader: AdminKpiReader,
        zone: MarketZone,
        clock: Clock,
        audit: AuditWriter,
        sheetWriter: SheetWriter,
      ) =>
        new ExportMarketplaceDaily(gate, { unitOfWork, reader, zone, clock, audit, sheetWriter }),
    },
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
    ...[
      ViewMarketplaceOperationsKpis,
      ViewMarketplaceFinanceKpis,
      ViewMarketplaceTopSellers,
      ViewMarketplaceTopCategories,
    ].map((type) => ({
      provide: type,
      inject: [USE_CASE_GATE, ADMIN_KPI_DEPENDENCIES],
      useFactory: (gate: UseCaseGate, deps: AdminKpiDependencies) => new type(gate, deps),
    })),
    {
      provide: REPORTING_KPI_FACADE,
      inject: [
        ViewMarketplaceOperationsKpis,
        ViewMarketplaceFinanceKpis,
        ViewMarketplaceTopSellers,
        ViewMarketplaceTopCategories,
        MARKET_ZONE,
        CLOCK,
      ],
      useFactory: (
        operations: ViewMarketplaceOperationsKpis,
        finance: ViewMarketplaceFinanceKpis,
        topSellers: ViewMarketplaceTopSellers,
        topCategories: ViewMarketplaceTopCategories,
        zone: MarketZone,
        clock: Clock,
      ) =>
        new ReportingKpiFacadeImplementation(operations, finance, topSellers, topCategories, {
          zone,
          clock,
        }),
    },
    registerSubscriptionsFrom('reporting', [RecordReportFacts], (record: RecordReportFacts) =>
      reportFactsSubscriptions(record),
    ),
    registerJobsFrom(
      'reporting',
      [ReconcileReportFacts, BackfillHistory],
      (reconcile: ReconcileReportFacts, backfill: BackfillHistory) => [
        reconcileReportFactsJob(reconcile),
        backfillHistoryJob(backfill),
      ],
    ),
  ],
  exports: [REPORTING_KPI_FACADE],
})
export class ReportingModule {}
