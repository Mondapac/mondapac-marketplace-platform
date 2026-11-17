import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { BehaviourEventRepository } from './ports/behaviour-event.repository';
import type { EngagementGuestTokens } from './ports/guest-tokens';
import type { PersonalizationSettingRepository } from './ports/personalization-setting.repository';
import type { PublishedStores } from './ports/published-stores';
import type { StoreFollowRepository } from './ports/store-follow.repository';

/** What every engagement use case may need; one object built from the same ports. */
export interface EngagementDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly events: BehaviourEventRepository;
  readonly settings: PersonalizationSettingRepository;
  readonly guestTokens: EngagementGuestTokens;
  /** Store follows (customers management phase 3). */
  readonly follows: StoreFollowRepository;
  readonly stores: PublishedStores;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
