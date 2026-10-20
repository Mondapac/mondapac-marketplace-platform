import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { SubjectRateLimits } from '../../platform/rate-limit/subject-rate-limits';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { NotificationsModule } from '../notifications';
import { SearchModule } from '../search';
import type { AssistantDependencies } from './application/assistant-dependencies';
import { ASSISTANT_RUNTIME } from './application/ports/assistant-runtime';
import { ASSISTANT_SETTINGS_REPOSITORY } from './application/ports/assistant-settings.repository';
import { ASSISTANT_TOOLS } from './application/ports/assistant-tools';
import { CONVERSATION_REPOSITORY } from './application/ports/conversation.repository';
import { GUEST_TOKENS } from './application/ports/guest-tokens';
import { MARKET_CALENDAR } from './application/ports/market-calendar';
import { MESSAGE_LIMITS } from './application/ports/message-limits';
import { SPEND_REPOSITORY } from './application/ports/spend.repository';
import { PurgeConversations } from './application/use-cases/purge-conversations.use-case';
import { SendGuestMessage } from './application/use-cases/send-guest-message.use-case';
import { SendMessage } from './application/use-cases/send-message.use-case';
import { SetAssistantSettings } from './application/use-cases/set-assistant-settings.use-case';
import { ViewAssistantSettings } from './application/use-cases/view-assistant-settings.use-case';
import { ViewStorefrontAssistant } from './application/use-cases/view-storefront-assistant.use-case';
import { ASSISTANT_PERMISSIONS } from './contracts';
import { ASSISTANT_AUDIT_ACTIONS } from './domain/audit';
import { assistantProviders } from './infrastructure/assistant-providers';
import { AdminAssistantSettingsController } from './presentation/admin-assistant-settings.controller';
import { ConversationController } from './presentation/conversation.controller';
import { purgeConversationsJob } from './presentation/jobs/purge-conversations.job';
import { StorefrontAssistantController } from './presentation/storefront-assistant.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: AssistantDependencies) => U;

const PORTS: readonly [keyof AssistantDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['settings', ASSISTANT_SETTINGS_REPOSITORY],
  ['runtime', ASSISTANT_RUNTIME],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
  ['conversations', CONVERSATION_REPOSITORY],
  ['spend', SPEND_REPOSITORY],
  ['tools', ASSISTANT_TOOLS],
  ['limits', MESSAGE_LIMITS],
  ['guestTokens', GUEST_TOKENS],
  ['calendar', MARKET_CALENDAR],
];

/** Every assistant use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as AssistantDependencies,
      ),
  };
}

/**
 * The buyer assistant (plan sections 2 to 11). Its per-Market settings (package 2): a platform
 * admin switches it on and tunes it; every change is a new insert-only version and an audit row;
 * the storefront reads the safe subset without a session. The conversation (package 4): a
 * customer's or guest's message, answered by the model through `platform/ai` with the READ tools
 * of `search`, `catalog` and `notifications`, checked by the reply guard and streamed as cards and
 * text; conversations are encrypted per conversation and purged by retention; spend is counted
 * per Market day and stops the assistant at a cap. The guardrails and the model API key are not
 * settings.
 */
@Module({
  imports: [SearchModule, CatalogModule, NotificationsModule],
  controllers: [
    AdminAssistantSettingsController,
    StorefrontAssistantController,
    ConversationController,
  ],
  providers: [
    PersistenceModule.auditWriterFor('assistant'),
    registerAuditActions('assistant', ASSISTANT_AUDIT_ACTIONS),
    registerPermissions('assistant', ASSISTANT_PERMISSIONS),
    SubjectRateLimits,
    ...assistantProviders,
    ...[
      ViewAssistantSettings,
      SetAssistantSettings,
      ViewStorefrontAssistant,
      SendMessage,
      SendGuestMessage,
      PurgeConversations,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    registerJobsFrom('assistant', [PurgeConversations], (purge: PurgeConversations) => [
      purgeConversationsJob(purge),
    ]),
  ],
})
export class AssistantModule {}
