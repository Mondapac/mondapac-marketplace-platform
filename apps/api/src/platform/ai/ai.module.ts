import { Module, type DynamicModule, type Type } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { CLOCK } from '../clock/clock.module';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketRegistry } from '../market-config/market-registry';
import { PersistenceModule } from '../persistence/persistence.module';
import { registerJobsFrom } from '../scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../unit-of-work/unit-of-work';
import { AiGateway } from './ai-gateway';
import { AnthropicMessagesProvider } from './anthropic-messages.provider';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway } from './model-gateway';
import { MODEL_PROVIDER } from './model-provider';
import { AiUsage } from './usage/ai-usage';
import { aiReservationSweeperJob, aiUsageRetentionJob } from './usage/ai-usage-jobs';
import { AiUsageReport } from './usage/ai-usage-report';
import { AI_USAGE_STORE, type AiUsageStore } from './usage/ai-usage-store';

/**
 * `platform/ai` (ADR-0019 decision 6; docs/design/domain/platform-ai.md): the only code that calls
 * a model. It imports no module. Modules reach a model only through {@link AiGateway}, imported
 * only by the files on the boundary allow-list (`.dependency-cruiser.cjs`), and register their
 * capabilities in the {@link CapabilityRegistry}. Tests replace {@link MODEL_PROVIDER} with a fake,
 * so `pnpm verify` stays offline and deterministic.
 *
 * The usage and budget store (`platform.ai_*`, design section 10) is bound here only and not
 * exported, so no module changes the AI budget; its two jobs (`platform.ai-reservation-
 * sweeper`, `platform.ai-usage-retention`) are registered in both roles and run by the worker.
 * {@link AiUsageReport} is the one read of it a module gets (G7): its own capability's settled
 * cost per day and its "cap reached" record, never what is held or a call's detail.
 *
 * `app.module.ts` passes the module that provides and exports `SELLER_AI_SWITCH` (sellers'), as it
 * does for identity's authorisation check, so `platform/` imports no module; a graph without it
 * fails boot with Nest's unknown-dependency error in both roles (ADR-0019 decision 7).
 */
@Module({})
export class AiModule {
  static register(sellerAiSwitchProvider: Type): DynamicModule {
    return {
      module: AiModule,
      global: true,
      imports: [sellerAiSwitchProvider],
      providers: [
        { provide: MODEL_PROVIDER, useValue: new AnthropicMessagesProvider() },
        ModelGateway,
        CapabilityRegistry,
        PersistenceModule.aiUsageStore(),
        {
          provide: AiUsage,
          inject: [UNIT_OF_WORK, AI_USAGE_STORE, CLOCK, ID_GENERATOR, MarketRegistry],
          useFactory: (
            unitOfWork: UnitOfWork,
            store: AiUsageStore,
            clock: Clock,
            ids: IdGenerator,
            markets: MarketRegistry,
          ) => new AiUsage(unitOfWork, store, clock, ids, markets),
        },
        registerJobsFrom('platform', [AiUsage], (usage: AiUsage) => [
          aiReservationSweeperJob(usage),
          aiUsageRetentionJob(usage),
        ]),
        AiGateway,
        AiUsageReport,
      ],
      exports: [AiGateway, CapabilityRegistry, AiUsageReport],
    };
  }
}
