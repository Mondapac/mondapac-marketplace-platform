import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { AiGateway } from './ai-gateway';
import { AnthropicMessagesProvider } from './anthropic-messages.provider';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway } from './model-gateway';
import { MODEL_PROVIDER } from './model-provider';

/**
 * `platform/ai` (ADR-0019 decision 6; docs/design/domain/platform-ai.md): the only code that calls
 * a model. It imports no module. Modules reach a model only through {@link AiGateway}, imported
 * only by the files on the boundary allow-list (`.dependency-cruiser.cjs`), and register their
 * capabilities in the {@link CapabilityRegistry}. Tests replace {@link MODEL_PROVIDER} with a fake,
 * so `pnpm verify` stays offline and deterministic.
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
        AiGateway,
      ],
      exports: [AiGateway, CapabilityRegistry],
    };
  }
}
