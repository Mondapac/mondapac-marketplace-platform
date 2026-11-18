import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import { StorefrontModule } from '../storefront';
import { PUBLISHED_STORES } from './application/ports/published-stores';
import { STORE_FOLLOW_REPOSITORY } from './application/ports/store-follow.repository';
import { FollowStore } from './application/use-cases/follow-store.use-case';
import { FollowedAmong } from './application/use-cases/followed-among.use-case';
import { FollowsOfAccount } from './application/use-cases/follows-of-account.use-case';
import { ListMyStores } from './application/use-cases/list-my-stores.use-case';
import { OwnFollowedAmong } from './application/use-cases/own-followed-among.use-case';
import { UnfollowStore } from './application/use-cases/unfollow-store.use-case';
import { ViewStoreFollow } from './application/use-cases/view-store-follow.use-case';
import { ENGAGEMENT_EVENTS } from './domain/store-follow';
import { StoreFollowsController } from './presentation/store-follows.controller';
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
import { AdminCustomerBehaviour } from './application/use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerCartAdditions } from './application/use-cases/admin-customer-cart-additions.use-case';
import { CUSTOMER_BEHAVIOUR_FACADE } from './contracts/customer-behaviour.facade';
import { ENGAGEMENT_FACADE } from './contracts/engagement.facade';
import { ENGAGEMENT_PERMISSIONS } from './contracts/permissions';
import { CustomerBehaviourFacadeImplementation } from './presentation/customer-behaviour.facade';
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
  ['follows', STORE_FOLLOW_REPOSITORY],
  ['stores', PUBLISHED_STORES],
  ['outbox', OUTBOX_WRITER],
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
 * its retention. The customer can switch it off, which deletes what was recorded. One permission
 * key, `engagement.customer-behaviour.view`, for the admin's customer page (customers management
 * phase 2b: counts and ids, never the search text). Phase 3 of customers management adds store
 * follows (`customers/me/followed-stores`) and publishes `engagement.store-followed.v1` and
 * `store-unfollowed.v1`. Package 1d-3: anonymous, aggregate-only daily counts of how often each
 * storefront block was shown and clicked (no person, cookie or address; 13 months), counted only
 * for placements storefront serves now, read by admins holding storefront's `storefront.page.stats`.
 */
@Module({
  imports: [StorefrontModule, SellersModule],
  controllers: [
    StoreFollowsController,
    BehaviourEventsController,
    PersonalizationController,
    BlockEventsController,
    AdminBlockStatsController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('engagement'),
    registerEvents('engagement', ENGAGEMENT_EVENTS),
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
      // Customers management phase 2b: the admin's reads of one customer's behaviour.
      AdminCustomerBehaviour,
      AdminCustomerCartAdditions,
      FollowStore,
      UnfollowStore,
      ViewStoreFollow,
      ListMyStores,
      FollowedAmong,
      OwnFollowedAmong,
      FollowsOfAccount,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    ...[RecordBlockEvents, PurgeExpiredBlockCounts, ViewBlockStats].map((type) =>
      blockUseCaseProvider(type as BlockUseCaseClass<unknown>),
    ),
    {
      provide: ENGAGEMENT_FACADE,
      inject: [
        ForgetAccount,
        RecentViewsOfCustomer,
        RecentViewsOfGuest,
        FollowedAmong,
        OwnFollowedAmong,
        FollowsOfAccount,
        FollowStore,
      ],
      useFactory: (
        forgetAccount: ForgetAccount,
        recentViewsOfCustomer: RecentViewsOfCustomer,
        recentViewsOfGuest: RecentViewsOfGuest,
        followedAmong: FollowedAmong,
        ownFollowedAmong: OwnFollowedAmong,
        followsOfAccount: FollowsOfAccount,
        followStore: FollowStore,
      ) =>
        new EngagementFacadeImplementation({
          forgetAccount,
          recentViewsOfCustomer,
          recentViewsOfGuest,
          followedAmong,
          ownFollowedAmong,
          followsOfAccount,
          followStore,
        }),
    },
    {
      provide: CUSTOMER_BEHAVIOUR_FACADE,
      inject: [AdminCustomerBehaviour, AdminCustomerCartAdditions],
      useFactory: (behaviour: AdminCustomerBehaviour, additions: AdminCustomerCartAdditions) =>
        new CustomerBehaviourFacadeImplementation(behaviour, additions),
    },
    registerPermissions('engagement', ENGAGEMENT_PERMISSIONS),
    registerJobsFrom('engagement', [PurgeExpiredEvents], (purge: PurgeExpiredEvents) => [
      purgeExpiredEventsJob(purge),
    ]),
    registerJobsFrom('engagement', [PurgeExpiredBlockCounts], (purge: PurgeExpiredBlockCounts) => [
      purgeExpiredBlockCountsJob(purge),
    ]),
  ],
  exports: [ENGAGEMENT_FACADE, CUSTOMER_BEHAVIOUR_FACADE],
})
export class EngagementModule {}
