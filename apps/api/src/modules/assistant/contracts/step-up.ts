import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * Switching the buyer assistant on in a Market (`enabled` false to true, `PUT
 * assistant/admin/settings`; AI Gateway G4d3, docs/design/domain/platform-ai.md section 8).
 * Switching it off, or any other change, needs none.
 */
export const ASSISTANT_RESUME_STEP_UP = 'assistant.settings.resume';

/**
 * The step-up actions assistant owns: an admin action, so a platform admin presents a fresh
 * two-step code (`POST identity/admin/step-up/verify`) before the change, and the proof is spent
 * in the change's own unit (ADR-0018).
 */
export const ASSISTANT_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: ASSISTANT_RESUME_STEP_UP, defaultRequired: true, locked: true, audience: 'admin' },
];
