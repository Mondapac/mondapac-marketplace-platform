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
import { InHouseHttpProvider } from './in-house-http.provider';
import { RouteProviders } from './route-providers';
import { checkedInCatalogue } from './catalogue';
import { AI_ROUTE_CATALOGUE, type RouteCatalogue } from './catalogue/route-catalogue';
import { AI_EVALUATION_RESULTS, EvaluationResults } from './evaluations/evaluation-results';
import { EVALUATION_PASSES } from './evaluations/results';
import { AiEvaluationControl } from './evaluations/evaluation-control';
import { EVALUATION_PROVIDERS } from './evaluations/evaluation-providers';
import { AiEvaluationRunner, aiEvaluationRunnerJob } from './evaluations/evaluation-runner';
import { EvaluationSuiteRegistry } from './evaluations/evaluation-suite';
import { AiModelChoices } from './model-choices';
import {
  AI_SHADOW_SAMPLER,
  InHouseShadow,
  RANDOM_SHADOW_SAMPLER,
} from './own-model/in-house-shadow';
import { InHouseHealth } from './own-model/in-house-health';
import { InHouseRollback } from './own-model/in-house-rollback';
import {
  AI_IN_HOUSE_HEALTH,
  AI_ROLLOUT_SAMPLER,
  InHouseRollout,
} from './own-model/in-house-rollout';
import { AI_SHADOW_APPROVALS, SHADOW_CUSTOMER_DATA_APPROVALS } from './own-model/in-house-stage';
import { ModelGateway } from './model-gateway';
import { MODEL_PROVIDER } from './model-provider';
import { AiRouter } from './routing/ai-router';
import { AiModelUsage } from './usage/ai-model-usage';
import { AiUsage } from './usage/ai-usage';
import { aiReservationSweeperJob, aiUsageRetentionJob } from './usage/ai-usage-jobs';
import { AiUsageReport } from './usage/ai-usage-report';
import { AI_USAGE_STORE, type AiUsageStore } from './usage/ai-usage-store';

/**
 * `platform/ai` (ADR-0019 decision 6; docs/design/domain/platform-ai.md): the only code that calls
 * a model. It imports no module. Modules reach a model only through {@link AiGateway}, imported
 * only by the files on the boundary allow-list (`.dependency-cruiser.cjs`), and register their
 * capabilities in the {@link CapabilityRegistry}. Tests replace {@link MODEL_PROVIDER} with a fake,
 * so `pnpm verify` stays offline and deterministic, and may replace the checked-in route catalogue
 * ({@link AI_ROUTE_CATALOGUE}) and evaluation passes ({@link AI_EVALUATION_RESULTS}) with rows
 * and passes of their own (the checked-in ones have no verified route yet, ADR-0052).
 *
 * The usage and budget store (`platform.ai_*`, design section 10) is bound here only and not
 * exported, so no module changes the AI budget; its two jobs (`platform.ai-reservation-
 * sweeper`, `platform.ai-usage-retention`) are registered in both roles and run by the worker.
 * {@link AiUsageReport} is the one read of it a module gets (G7): its own capability's settled
 * cost per day and its "cap reached" record, never what is held or a call's detail.
 * {@link AiModelChoices} is settings' check of a Market's model lists against the catalogue (G4b),
 * and {@link AiModelUsage} its read of the last 30 days per model family and task type (G5e).
 * G4c: modules register their evaluation suites in the {@link EvaluationSuiteRegistry}; the job
 * `platform.ai-evaluation-runner` works evaluation runs through the evaluation gateway (not
 * exported), and {@link AiEvaluationControl} is settings' port for the run and playground API. The
 * evaluation store is bound here only, like the usage store.
 * G6c: {@link InHouseShadow} sends a share of a capability's calls also to the in-house model,
 * measured only, under the owner's approvals ({@link AI_SHADOW_APPROVALS}, checked-in) and the
 * sampler ({@link AI_SHADOW_SAMPLER}); tests may bind their own, like the catalogue.
 * G6d1: {@link InHouseHealth} keeps each in-house row's health check (contract `GET /v1/health`),
 * which G6d's live stages require. G6d2: {@link InHouseRollout} lets the in-house model answer a
 * share of a task type's calls (percent) or all of them (default), external models behind it, only
 * through healthy routes; tests bind their own health ({@link AI_IN_HOUSE_HEALTH}) and sampler.
 * G6d3: {@link InHouseRollback} judges the live stages on the usage store and holds a task type's
 * live stage off after a rollback, until an admin changes its settings.
 *
 * `app.module.ts` passes the module that provides and exports `SELLER_AI_SWITCH` (sellers'), as it
 * does for identity's authorisation check, so `platform/` imports no module; a graph without it
 * fails boot with Nest's unknown-dependency error in both roles (ADR-0019 decision 7). It passes
 * the module that provides and exports `AI_GATEWAY_CONTROLS` (settings', G4) the same way.
 */
@Module({})
export class AiModule {
  static register(sellerAiSwitchProvider: Type, gatewayControlsProvider: Type): DynamicModule {
    return {
      module: AiModule,
      global: true,
      imports: [sellerAiSwitchProvider, gatewayControlsProvider],
      providers: [
        {
          provide: MODEL_PROVIDER,
          useFactory: () => {
            const messages = new AnthropicMessagesProvider();
            return new RouteProviders({
              'anthropic-api': messages,
              'bedrock-mantle': messages,
              'in-house-http': new InHouseHttpProvider(),
            });
          },
        },
        { provide: AI_ROUTE_CATALOGUE, useFactory: () => checkedInCatalogue() },
        {
          provide: AI_EVALUATION_RESULTS,
          useFactory: () => new EvaluationResults(EVALUATION_PASSES),
        },
        ModelGateway,
        {
          provide: AiRouter,
          inject: [AI_ROUTE_CATALOGUE, AI_EVALUATION_RESULTS, ModelGateway, MarketRegistry, CLOCK],
          useFactory: (
            catalogue: RouteCatalogue,
            evaluations: EvaluationResults,
            models: ModelGateway,
            markets: MarketRegistry,
            clock: Clock,
          ) => new AiRouter(catalogue, evaluations, models, markets, clock),
        },
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
        ...EVALUATION_PROVIDERS,
        registerJobsFrom(
          'platform',
          [AiUsage, AiEvaluationRunner],
          (usage: AiUsage, runner: AiEvaluationRunner) => [
            aiReservationSweeperJob(usage),
            aiUsageRetentionJob(usage, runner),
            aiEvaluationRunnerJob(runner),
          ],
        ),
        { provide: AI_SHADOW_APPROVALS, useValue: SHADOW_CUSTOMER_DATA_APPROVALS },
        { provide: AI_SHADOW_SAMPLER, useValue: RANDOM_SHADOW_SAMPLER },
        InHouseShadow,
        InHouseHealth,
        { provide: AI_IN_HOUSE_HEALTH, useExisting: InHouseHealth },
        { provide: AI_ROLLOUT_SAMPLER, useValue: RANDOM_SHADOW_SAMPLER },
        InHouseRollout,
        InHouseRollback,
        AiGateway,
        AiUsageReport,
        AiModelChoices,
        AiModelUsage,
      ],
      exports: [
        AiGateway,
        CapabilityRegistry,
        AiUsageReport,
        AiModelChoices,
        AiModelUsage,
        EvaluationSuiteRegistry,
        AiEvaluationControl,
      ],
    };
  }
}
