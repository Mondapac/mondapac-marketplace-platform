import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_MANAGE } from '../../contracts/permissions';
import { AI_DESCRIPTION_WRITER_CODE } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSetting, type SettingsFailure, type SettingChangeView } from '../settings-flow';

interface Input {
  readonly code?: unknown;
  readonly value?: unknown;
  readonly expectedVersion?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/** The writer's model tier went in AI Gateway G4d1: its code is refused like any other. */
const AI_CODES: readonly string[] = [AI_DESCRIPTION_WRITER_CODE];

/**
 * `settings.change-ai-setting`: an admin changes one AI setting of the Market (the description
 * writer's switch) from the version they saw. Protected key; refused in
 * acting-as, audited, idempotent, and a stale version is a conflict.
 */
export class ChangeAiSetting extends UseCase<Input, SettingChangeView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-ai-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_MANAGE.key] },
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
  ): Promise<Result<SettingChangeView, SettingsFailure>> {
    const code = input?.code;
    if (typeof code !== 'string' || !AI_CODES.includes(code)) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'code', code: 'value' }] }),
      );
    }
    return changeSetting(this.deps, context, code, input);
  }
}
