import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_VIEW } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  ASSISTANT_SETTINGS_CHANGES,
  viewAssistantSettings,
  type AssistantSettingsFailure,
  type AssistantSettingsPage,
} from '../settings-flow';

/** `assistant.view-assistant-settings`: an admin reads the Market's buyer assistant settings. */
export class ViewAssistantSettings extends UseCase<
  Record<string, never>,
  AssistantSettingsPage,
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

  protected async handle(
    context: CallContext,
  ): Promise<Result<AssistantSettingsPage, AssistantSettingsFailure>> {
    const view = await viewAssistantSettings(this.deps, context);
    if (!view.ok) return view;
    const lastChanged = await this.deps.trail.lastChanged(context, ASSISTANT_SETTINGS_CHANGES);
    return ok({ ...view.value, lastChanged });
  }
}
