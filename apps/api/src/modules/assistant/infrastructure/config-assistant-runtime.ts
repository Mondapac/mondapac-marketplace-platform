import type { AppConfig } from '../../../platform/config/app-config';
import type { AssistantRuntime } from '../application/ports/assistant-runtime';
import type { ModelTier } from '../domain/assistant-settings';

/**
 * {@link AssistantRuntime} from the server environment. It keeps no copy of the API key: it
 * answers only whether one is set.
 */
export class ConfigAssistantRuntime implements AssistantRuntime {
  readonly #keyConfigured: boolean;
  readonly #models: Readonly<Record<ModelTier, string | null>>;

  constructor(config: AppConfig) {
    this.#keyConfigured = config.assistantModelApiKey !== null;
    this.#models = config.assistantModels;
  }

  apiKeyConfigured(): boolean {
    return this.#keyConfigured;
  }

  modelOf(tier: ModelTier): string | null {
    return this.#models[tier];
  }
}
