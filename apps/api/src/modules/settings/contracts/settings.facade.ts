import type { CallContext } from '@mondapac/shared-kernel';
import type { AiModelTierSetting } from '../domain/definitions';

/**
 * What other modules read from the settings store (ADR-0026 decision 2). Each method carries the
 * caller's `CallContext` unchanged and answers for its Market alone.
 */
export interface SettingsFacade {
  /**
   * Whether the AI description writer is on in the Market, and its model tier (AIS-03). Never an
   * error: a store that cannot be read answers off (ADR-0019 R8).
   */
  aiDescriptionWriter(
    context: CallContext,
  ): Promise<{ readonly enabled: boolean; readonly tier: AiModelTierSetting }>;
}

export const SETTINGS_FACADE = Symbol('SETTINGS_FACADE');
