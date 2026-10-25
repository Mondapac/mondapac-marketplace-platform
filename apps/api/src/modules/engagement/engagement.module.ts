import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { StorefrontModule } from '../storefront';
import type { BlockCountDependencies } from './application/block-count-flow';
import type { EngagementDependencies } from './application/engagement-dependencies';
import { BLOCK_COUNT_REPOSITORY } from './application/ports/block-count.repository';
import { SERVED_PLACEMENTS } from './application/ports/served-placements';
import { PurgeExpiredBlockCounts } from './application/use-cases/purge-expired-block-counts.use-case';
import { ViewBlockStats } from './application/use-cases/view-block-stats.use-case';
import { RecordBlockEvents } from './application/use-cases/record-block-events.use-case';
import { BEHAVIOUR_EVENT_REPOSITORY } from './application/ports/behaviour-event.repository';
import { ENGAGEMENT_GUEST_TOKENS } from './application/ports/guest-tokens';
import { PERSONALIZATION_SETTING_REPOSITORY } from './application/ports/personalization-setting.repository';
import { ForgetAccount } from './application/use-cases/forget-account.use-case';
import { PurgeExpiredEvents } from './application/use-cases/purge-expired-events.use-case';
import { RecentViewsOfGuest } from './application/use-cases/recent-views-guest.use-case';
import { RecentViewsOfCustomer } from './application/use-cases/recent-views.use-case';
import { RecordEvent } from './application/use-cases/record-event.use-case';
import { RecordGuestEvent } from './application/use-cases/record-guest-event.use-case';
import { SetPersonalization } from './application/use-cases/set-personalization.use-case';
import { ViewPersonalization } from './application/use-cases/view-personalization.use-case';
import { ENGAGEMENT_FACADE } from './contracts/engagement.facade';
import { engagementProviders } from './infrastructure/engagement-providers';
import { BehaviourEventsController } from './presentation/behaviour-events.controller';
import { AdminBlockStatsController } from './presentation/admin-block-stats.controller';
import { BlockEventsController } from './presentation/block-events.controller';
import { purgeExpiredBlockCountsJob } from './presentation/jobs/purge-expired-block-counts.job';
import { EngagementFacadeImplementation } from './presentation/engagement.facade';
import { purgeExpiredEventsJob } from './presentation/jobs/purge-expired-events.job';
import { PersonalizationController } from './presentation/personalization.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: EngagementDependencies) => U;

const PORTS: readonly [keyof EngagementDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['events', BEHAVIOUR_EVENT_REPOSITORY],
  ['settings', PERSONALIZATION_SETTING_REPOSITORY],
  ['guestTokens', ENGAGEMENT_GUEST_TOKENS],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

const BLOCK_PORTS: readonly [keyof BlockCountDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['counts', BLOCK_COUNT_REPOSITORY],
  ['served', SERVED_PLACEMENTS],
  ['clock', CLOCK],
];

type BlockUseCaseClass<U> = new (gate: UseCaseGate, deps: BlockCountDependencies) => U;

/** The block-count use cases share a smaller dependency object (package 1d-3). */
function blockUseCaseProvider<U>(type: BlockUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...BLOCK_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          BLOCK_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as BlockCountDependencies,
      ),
  };
}

/** Every engagement use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as EngagementDependencies,
      ),
  };
}

/**
 * Engagement: the shopping behaviour behind personalization (package 1a; owner decisions 4 and
 * 5 of 2026-10-18). Records what a shopper viewed, searched for or added to the cart, by ids, for
 * a signed-in customer (12 months) or a guest cookie (30 days); the daily job deletes what is past
 * its retention. The customer can switch it off, which deletes what was recorded. No permission
 * key; no event published. Package 1d-3: anonymous, aggregate-only daily counts of how often each
 * storefront block was shown and clicked (no person, cookie or address; 13 months), counted only
 * for placements storefront serves now, read by admins holding storefront's `storefront.page.stats`.
 */
@Module({
  imports: [StorefrontModule],
  controllers: [
    BehaviourEventsController,
    PersonalizationController,
    BlockEventsController,
    AdminBlockStatsController,
  ],
  providers: [
    ...engagementProviders,
    ...[
      RecordEvent,
      RecordGuestEvent,
      ViewPersonalization,
      SetPersonalization,
      PurgeExpiredEvents,
      ForgetAccount,
      RecentViewsOfCustomer,
      RecentViewsOfGuest,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    ...[RecordBlockEvents, PurgeExpiredBlockCounts, ViewBlockStats].map((type) =>
      blockUseCaseProvider(type as BlockUseCaseClass<unknown>),
    ),
    {
      provide: ENGAGEMENT_FACADE,
      inject: [ForgetAccount, RecentViewsOfCustomer, RecentViewsOfGuest],
      useFactory: (
        forgetAccount: ForgetAccount,
        recentViewsOfCustomer: RecentViewsOfCustomer,
        recentViewsOfGuest: RecentViewsOfGuest,
      ) =>
        new EngagementFacadeImplementation({
          forgetAccount,
          recentViewsOfCustomer,
          recentViewsOfGuest,
        }),
    },
    registerJobsFrom('engagement', [PurgeExpiredEvents], (purge: PurgeExpiredEvents) => [
      purgeExpiredEventsJob(purge),
    ]),
    registerJobsFrom('engagement', [PurgeExpiredBlockCounts], (purge: PurgeExpiredBlockCounts) => [
      purgeExpiredBlockCountsJob(purge),
    ]),
  ],
  exports: [ENGAGEMENT_FACADE],
})
export class EngagementModule {}
