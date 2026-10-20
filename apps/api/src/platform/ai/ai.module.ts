import { Global, Module } from '@nestjs/common';
import { AnthropicMessagesProvider } from './anthropic-messages.provider';
import { ModelGateway } from './model-gateway';
import { MODEL_PROVIDER } from './model-provider';

/**
 * `platform/ai` (ADR-0019 decision 6): the only code that calls a model. It imports no module.
 * Its one entry point, {@link ModelGateway}, is imported only by the files on the boundary
 * allow-list (`.dependency-cruiser.cjs`). Tests replace {@link MODEL_PROVIDER} with a fake, so
 * `pnpm verify` stays offline and deterministic.
 */
@Global()
@Module({
  providers: [{ provide: MODEL_PROVIDER, useValue: new AnthropicMessagesProvider() }, ModelGateway],
  exports: [ModelGateway],
})
export class AiModule {}
