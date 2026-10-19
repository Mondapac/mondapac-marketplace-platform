import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { EngagementDependencies } from './application/engagement-dependencies';
import { BEHAVIOUR_EVENT_REPOSITORY } from './application/ports/behaviour-event.repository';
import { ENGAGEMENT_GUEST_TOKENS } from './application/ports/guest-tokens';
import { PERSONALIZATION_SETTING_REPOSITORY } from './application/ports/personalization-setting.repository';
import { ForgetAccount } from './application/use-cases/forget-account.use-case';
import { PurgeExpiredEvents } from './application/use-cases/purge-expired-events.use-case';
import { RecordEvent } from './application/use-cases/record-event.use-case';
import { RecordGuestEvent } from './application/use-cases/record-guest-event.use-case';
import { SetPersonalization } from './application/use-cases/set-personalization.use-case';
import { ViewPersonalization } from './application/use-cases/view-personalization.use-case';
import { ENGAGEMENT_FACADE } from './contracts/engagement.facade';
import { engagementProviders } from './infrastructure/engagement-providers';
import { BehaviourEventsController } from './presentation/behaviour-events.controller';
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
 * key; no event published.
 */
@Module({
  controllers: [BehaviourEventsController, PersonalizationController],
  providers: [
    ...engagementProviders,
    ...[
      RecordEvent,
      RecordGuestEvent,
      ViewPersonalization,
      SetPersonalization,
      PurgeExpiredEvents,
      ForgetAccount,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: ENGAGEMENT_FACADE,
      inject: [ForgetAccount],
      useFactory: (forgetAccount: ForgetAccount) =>
        new EngagementFacadeImplementation({ forgetAccount }),
    },
    registerJobsFrom('engagement', [PurgeExpiredEvents], (purge: PurgeExpiredEvents) => [
      purgeExpiredEventsJob(purge),
    ]),
  ],
  exports: [ENGAGEMENT_FACADE],
})
export class EngagementModule {}
