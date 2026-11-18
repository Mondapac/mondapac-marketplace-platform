import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { MarketingConsentRepository } from './ports/marketing-consent.repository';

/** What every legal use case may need; one object built from the same ports. */
export interface LegalDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly consents: MarketingConsentRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** legal's own outbox: `legal.marketing-consent-changed.v1`, written in the unit of the change. */
  readonly outbox: OutboxWriter;
}
