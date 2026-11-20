import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_VIEW } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import { viewInsights, type AssistantInsights, type ViewInsightsFailure } from '../insights-flow';

export type { AssistantInsights } from '../insights-flow';

/**
 * `assistant.view-assistant-insights`: an admin reads how the buyer assistant is doing: the
 * thumbs, the spend and the questions it did not answer well, with masked buyer text only.
 */
export class ViewAssistantInsights extends UseCase<
  Record<string, unknown>,
  AssistantInsights,
  ViewInsightsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.view-assistant-insights',
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
    query: Record<string, unknown>,
  ): Promise<Result<AssistantInsights, ViewInsightsFailure>> {
    return viewInsights(this.deps, context, query);
  }
}
