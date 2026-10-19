import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { AssistantDependencies } from './application/assistant-dependencies';
import { ASSISTANT_RUNTIME } from './application/ports/assistant-runtime';
import { ASSISTANT_SETTINGS_REPOSITORY } from './application/ports/assistant-settings.repository';
import { SetAssistantSettings } from './application/use-cases/set-assistant-settings.use-case';
import { ViewAssistantSettings } from './application/use-cases/view-assistant-settings.use-case';
import { ViewStorefrontAssistant } from './application/use-cases/view-storefront-assistant.use-case';
import { ASSISTANT_PERMISSIONS } from './contracts';
import { ASSISTANT_AUDIT_ACTIONS } from './domain/audit';
import { assistantProviders } from './infrastructure/assistant-providers';
import { AdminAssistantSettingsController } from './presentation/admin-assistant-settings.controller';
import { StorefrontAssistantController } from './presentation/storefront-assistant.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: AssistantDependencies) => U;

const PORTS: readonly [keyof AssistantDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['settings', ASSISTANT_SETTINGS_REPOSITORY],
  ['runtime', ASSISTANT_RUNTIME],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
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
 * The buyer assistant (plan section 11, package 2): so far its per-Market settings only. A
 * platform admin switches it on and tunes it (rollout, model tier, limits, retention, language,
 * spend caps, support hand-off, welcome text); every change is a new insert-only version and an
 * audit row. The storefront reads the safe subset without a session. The guardrails and the
 * model API key are not settings. The conversation endpoint comes in a later package.
 */
@Module({
  controllers: [AdminAssistantSettingsController, StorefrontAssistantController],
  providers: [
    PersistenceModule.auditWriterFor('assistant'),
    registerAuditActions('assistant', ASSISTANT_AUDIT_ACTIONS),
    registerPermissions('assistant', ASSISTANT_PERMISSIONS),
    ...assistantProviders,
    ...[ViewAssistantSettings, SetAssistantSettings, ViewStorefrontAssistant].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
  ],
})
export class AssistantModule {}
