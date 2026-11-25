import type { StepUpActionDeclaration } from '../../../platform/authz';

/** Switching the Offer review emergency stop (R0) on or off (`PUT settings/admin/offer-review/emergency-stop`). */
export const SETTINGS_EMERGENCY_STOP_STEP_UP = 'settings.offer-review-emergency-stop.change';
/** Changing the Offer review policy page (`PUT settings/admin/offer-review`). */
export const SETTINGS_OFFER_REVIEW_STEP_UP = 'settings.offer-review.change';

/** Raising or lifting an AI cap (`PUT settings/admin/ai-gateway/limits`); lowering needs none. */
export const SETTINGS_AI_GATEWAY_LIMITS_STEP_UP = 'settings.ai-gateway-limits.raise';
/**
 * Switching the Market's AI emergency stop off, AI on again (`PUT
 * settings/admin/ai-gateway/emergency-stop`); switching it on needs none.
 */
export const SETTINGS_AI_GATEWAY_RESUME_STEP_UP = 'settings.ai-gateway-emergency-stop.resume';
/** Any change of the Market's AI model lists, saver models or saver threshold (`PUT settings/admin/ai-models`). */
export const SETTINGS_AI_MODELS_STEP_UP = 'settings.ai-models.change';
/**
 * Starting an evaluation run of a model, after its estimate (`POST settings/admin/ai-models/
 * evaluations`, AI Gateway G4c): it spends the evaluation budget on a real model.
 */
export const SETTINGS_AI_EVALUATION_STEP_UP = 'settings.ai-evaluation.run';

/**
 * The step-up actions settings owns (Hassan, PR 2b). Both are admin actions: a platform admin
 * presents a fresh two-step code (`POST identity/admin/step-up/verify`) before the change, and the
 * proof is spent in the change's own unit (ADR-0018). One change can send every new Offer of the
 * Market past the admin, or stop them all.
 */
export const SETTINGS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: SETTINGS_EMERGENCY_STOP_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
  { key: SETTINGS_OFFER_REVIEW_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
  // AI Gateway (design section 8, owner decision): only a change that allows more AI.
  {
    key: SETTINGS_AI_GATEWAY_LIMITS_STEP_UP,
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: SETTINGS_AI_GATEWAY_RESUME_STEP_UP,
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  // The External models tab (G4b): every change, since any model change can move data or cost.
  { key: SETTINGS_AI_MODELS_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
  // An evaluation run (G4c): the estimated cost is confirmed with TOTP (design section 8).
  { key: SETTINGS_AI_EVALUATION_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
];
