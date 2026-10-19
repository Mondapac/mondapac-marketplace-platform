import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_MANAGE } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  setAssistantSettings,
  type AssistantSettingsFailure,
  type AssistantSettingsView,
} from '../settings-flow';

interface Input {
  readonly settings: unknown;
  readonly expectedVersion: unknown;
}

/** `assistant.set-assistant-settings`: an admin replaces the Market's buyer assistant settings (protected key). */
export class SetAssistantSettings extends UseCase<
  Input,
  AssistantSettingsView,
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

  protected handle(context: CallContext, input: Input) {
    return setAssistantSettings(this.deps, context, input);
  }
}
