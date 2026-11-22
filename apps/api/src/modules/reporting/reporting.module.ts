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
  ORDERING_REPORTING_FACADE,
  OrderingModule,
  type OrderingReportingFacade,
} from '../ordering';
import type { BackfillDependencies } from './application/backfill-history';
import { FactRecorder } from './application/fact-recorder';
import {
  BACKFILL_PROGRESS_STORE,
  type BackfillProgressStore,
} from './application/ports/backfill-progress-store';
import { REPORT_SOURCES, type ReportSources } from './application/ports/report-sources';
import type { ReportFactsDependencies } from './application/report-facts-sync';
import { BackfillHistory } from './application/use-cases/backfill-history.use-case';
import { ReconcileReportFacts } from './application/use-cases/reconcile-report-facts.use-case';
import { RecordReportFacts } from './application/use-cases/record-report-facts.use-case';
import { FacadeReportSources } from './infrastructure/facade-report-sources';
import { reportingProviders } from './infrastructure/reporting-providers';
import { backfillHistoryJob } from './presentation/jobs/backfill-history.job';
import { reconcileReportFactsJob } from './presentation/jobs/reconcile-report-facts.job';
import { reportFactsSubscriptions } from './presentation/subscribers/report-facts.subscriptions';

const REPORT_FACTS_DEPENDENCIES = Symbol('REPORT_FACTS_DEPENDENCIES');

/**
 * The reporting module (dashboards upgrade, option B, phase 3): the facts behind the dashboard
 * numbers and their daily rollups. It reads no table of another module: the facts come from
 * ordering's reporting facade and catalog's `offerPrimaryCategories`, through the event worker
 * (ordering's order and refund events) and the nightly reconcile. No module imports it. It
 * publishes no event and holds no permission yet (the KPI reads of phases 5 and 6 add them). The history backfill job brings
 * the facts recorded before the module was deployed in, once.
 */
@Module({
  imports: [PersistenceModule, OrderingModule, CatalogModule],
  providers: [
    ...reportingProviders,
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
})
export class ReportingModule {}
