import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_MANAGE } from '../../contracts/permissions';
import { SETTINGS_AI_CAPABILITY_RESUME_STEP_UP } from '../../contracts/step-up';
import { AI_CAPABILITY_SWITCH_CODES, loosensAi } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /** `[{ code, value, expectedVersion }]`, each capability switch at most once; `off` or `on`. */
  readonly changes?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/**
 * `settings.change-ai-capabilities` (AI Gateway G4d3, docs/design/domain/platform-ai.md section
 * 5): an admin holding the protected AI Gateway key switches single AI capabilities of the Market
 * off or on, every changed switch with the version they saw, all or nothing. Switching one off
 * never asks for a two-step code, so it is never slowed down; switching one on spends the admin's
 * fresh code in the change's unit (`settings.ai-capability.resume`). Refused in acting-as, audited
 * per switch, reviewed at high risk where the area is reviewed, and a rejected review never
 * switches one on. The gateway reads the switches on its next call; the module switches (the
 * writer's, the assistant's) and the seller's (SEL-25) still apply on top.
 */
export class ChangeAiCapabilities extends UseCase<
  Input,
  readonly SettingChangeView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-ai-capabilities',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly SettingChangeView[], SettingsFailure>> {
    return changeSettings(this.deps, context, AI_CAPABILITY_SWITCH_CODES, input ?? {}, {
      action: SETTINGS_AI_CAPABILITY_RESUME_STEP_UP,
      when: loosensAi,
    });
  }
}
