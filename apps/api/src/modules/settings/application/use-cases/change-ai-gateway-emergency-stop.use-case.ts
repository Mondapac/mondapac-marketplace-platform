import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_MANAGE } from '../../contracts/permissions';
import { SETTINGS_AI_GATEWAY_RESUME_STEP_UP } from '../../contracts/step-up';
import { AI_GATEWAY_EMERGENCY_STOP_CODE, loosensAi } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /** `on` (every AI capability of the Market off) or `off`. */
  readonly value?: unknown;
  /** The version the admin saw (0 while the default is in force). */
  readonly expectedVersion?: unknown;
  /** Why: always required, 1 to 500 characters, kept with the change and its review. */
  readonly note?: unknown;
}

/** The longest reason the stop takes (the settings note limit). */
const MAX_NOTE = 500;

/**
 * `settings.change-ai-gateway-emergency-stop` (AI Gateway page, docs/design/domain/platform-ai.md
 * section 8): an admin holding the protected AI Gateway key switches every AI capability of the
 * Market off, or on again. A reason is always required. Switching the stop on never asks for a
 * two-step code, so it is never slowed down; switching it off spends the admin's fresh code in the
 * change's unit (`settings.ai-gateway-emergency-stop.resume`). Audited, reviewed at high risk where
 * the area is reviewed, and a revert never switches it off. The server-wide `AI_KILL_SWITCH` stays
 * an operator's environment setting.
 */
export class ChangeAiGatewayEmergencyStop extends UseCase<
  Input,
  readonly SettingChangeView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-ai-gateway-emergency-stop',
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
    const note = typeof input?.note === 'string' ? input.note.trim() : '';
    if (note.length === 0 || note.length > MAX_NOTE) {
      const code = note.length === 0 ? 'required' : 'too-long';
      return Promise.resolve(err({ code: 'validation.failed', fields: [{ path: 'note', code }] }));
    }
    return changeSettings(
      this.deps,
      context,
      [AI_GATEWAY_EMERGENCY_STOP_CODE],
      {
        changes: [
          {
            code: AI_GATEWAY_EMERGENCY_STOP_CODE,
            value: input.value,
            expectedVersion: input.expectedVersion,
          },
        ],
        note,
      },
      { action: SETTINGS_AI_GATEWAY_RESUME_STEP_UP, when: loosensAi },
    );
  }
}
