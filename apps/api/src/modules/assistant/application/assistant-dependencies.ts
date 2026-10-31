import type { Clock } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { ChangeTrail } from '../../../platform/audit/change-trail';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AssistantRuntime } from './ports/assistant-runtime';
import type { AssistantSettingsRepository } from './ports/assistant-settings.repository';
import type { AssistantTools } from './ports/assistant-tools';
import type { ConversationRepository } from './ports/conversation.repository';
import type { GuestTokens } from './ports/guest-tokens';
import type { MarketCalendar } from './ports/market-calendar';
import type { MessageLimits } from './ports/message-limits';
import type { SpendRepository } from './ports/spend.repository';

/** What every assistant use case may need; one object built from the same ports. */
export interface AssistantDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly settings: AssistantSettingsRepository;
  readonly runtime: AssistantRuntime;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly conversations: ConversationRepository;
  readonly spend: SpendRepository;
  readonly tools: AssistantTools;
  readonly limits: MessageLimits;
  readonly guestTokens: GuestTokens;
  readonly calendar: MarketCalendar;
  /** "Last changed by" and the history of the settings, from this module's audit rows. */
  readonly trail: ChangeTrail;
}
