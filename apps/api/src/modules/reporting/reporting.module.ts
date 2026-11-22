import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { reportingProviders } from './infrastructure/reporting-providers';

/**
 * The reporting module (dashboards upgrade, option B, phase 3): the facts behind the dashboard
 * numbers and their daily rollups. It reads no table of another module; the facts arrive from the
 * owners' facades through the event worker, the nightly reconcile and the history backfill, which
 * bind here in later PRs. It publishes no event and holds no permission yet (the KPI reads of
 * phases 5 and 6 add them).
 */
@Module({
  imports: [PersistenceModule],
  providers: [...reportingProviders],
})
export class ReportingModule {}
