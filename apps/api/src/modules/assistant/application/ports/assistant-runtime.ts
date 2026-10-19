import type { ModelTier } from '../../domain/assistant-settings';

/**
 * What the server environment says about the model provider. The API key itself never leaves the
 * infrastructure layer: the settings screens learn only whether it is set.
 */
export interface AssistantRuntime {
  apiKeyConfigured(): boolean;
  /** The provider model id configured for a tier, or null when the environment names none. */
  modelOf(tier: ModelTier): string | null;
}

export const ASSISTANT_RUNTIME = Symbol('ASSISTANT_RUNTIME');
