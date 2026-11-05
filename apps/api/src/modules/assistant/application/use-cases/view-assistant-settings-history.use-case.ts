import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ChangeHistoryFailure,
  ChangeHistoryInput,
  ChangeHistoryPage,
} from '../../../../platform/audit/change-trail';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_VIEW } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import { ASSISTANT_SETTINGS_CHANGES } from '../settings-flow';

/**
 * `assistant.view-assistant-settings-history`: the changes of the Market's buyer assistant
 * settings, newest first, from the `assistant.settings.changed` audit rows: when, who (a display
 * name) and the names of the fields that changed (never a value). Same gate as the page.
 */
export class ViewAssistantSettingsHistory extends UseCase<
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeHistoryFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.view-assistant-settings-history',
    rule: { kind: 'permissions', allOf: [ASSISTANT_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure | { readonly code: 'access.denied' }>> {
    // As the page it explains: an admin session only, whatever keys another population holds.
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.trail.history(context, ASSISTANT_SETTINGS_CHANGES, input ?? {});
  }
}
