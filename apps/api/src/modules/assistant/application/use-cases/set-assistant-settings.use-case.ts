import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_MANAGE } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  ASSISTANT_SETTINGS_CHANGES,
  setAssistantSettings,
  type AssistantSettingsFailure,
  type AssistantSettingsPage,
} from '../settings-flow';

interface Input {
  readonly settings: unknown;
  readonly expectedVersion: unknown;
}

/** `assistant.set-assistant-settings`: an admin replaces the Market's buyer assistant settings (protected key). */
export class SetAssistantSettings extends UseCase<
  Input,
  AssistantSettingsPage,
  AssistantSettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.set-assistant-settings',
    rule: { kind: 'permissions', allOf: [ASSISTANT_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<AssistantSettingsPage, AssistantSettingsFailure>> {
    const result = await setAssistantSettings(this.deps, context, input);
    if (result.ok || result.error.code === 'assistant.conflict') {
      // The latest change is the save just made or, on a conflict, the winning one.
      const lastChanged = await this.deps.trail.lastChanged(context, ASSISTANT_SETTINGS_CHANGES);
      return result.ok
        ? ok({ ...result.value, lastChanged })
        : err({ code: 'assistant.conflict', lastChanged });
    }
    return result;
  }
}
