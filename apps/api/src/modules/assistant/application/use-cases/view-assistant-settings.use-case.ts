import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_VIEW } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  viewAssistantSettings,
  type AssistantSettingsFailure,
  type AssistantSettingsView,
} from '../settings-flow';

/** `assistant.view-assistant-settings`: an admin reads the Market's buyer assistant settings. */
export class ViewAssistantSettings extends UseCase<
  Record<string, never>,
  AssistantSettingsView,
  AssistantSettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.view-assistant-settings',
    rule: { kind: 'permissions', allOf: [ASSISTANT_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewAssistantSettings(this.deps, context);
  }
}
