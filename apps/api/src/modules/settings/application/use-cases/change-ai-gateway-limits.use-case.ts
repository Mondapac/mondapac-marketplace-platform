import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_MANAGE } from '../../contracts/permissions';
import { SETTINGS_AI_GATEWAY_LIMITS_STEP_UP } from '../../contracts/step-up';
import { AI_CAP_CODES, loosensAi } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /** `[{ code, value, expectedVersion }]`, each AI cap at most once; a value is `none` or micro-USD. */
  readonly changes?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/**
 * `settings.change-ai-gateway-limits`: an admin holding the protected AI Gateway key saves the
 * Limits tab (docs/design/domain/platform-ai.md sections 7 and 8), every changed cap with the
 * version they saw, all or nothing. Raising or lifting a cap spends the admin's fresh two-step code
 * in the change's unit (`settings.ai-gateway-limits.raise`); lowering one never asks for it.
 * Refused in acting-as, audited per cap, reviewed at high risk where the area is reviewed, and the
 * gateway reads the new caps on its next call.
 */
export class ChangeAiGatewayLimits extends UseCase<
  Input,
  readonly SettingChangeView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-ai-gateway-limits',
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
    return changeSettings(this.deps, context, AI_CAP_CODES, input ?? {}, {
      action: SETTINGS_AI_GATEWAY_LIMITS_STEP_UP,
      when: loosensAi,
    });
  }
}
