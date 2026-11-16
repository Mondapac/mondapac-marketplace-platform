import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSISTANT_SETTINGS_MANAGE } from '../../contracts/permissions';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  issuePreviewToken,
  type PreviewTokenFailure,
  type PreviewTokenView,
} from '../settings-flow';

/**
 * `assistant.issue-preview-token`: an admin takes a 30-minute internal preview token to the
 * storefront (protected key, the same as changing the settings: the token reaches the model and
 * its spend).
 */
export class IssuePreviewToken extends UseCase<
  Record<string, never>,
  PreviewTokenView,
  PreviewTokenFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.issue-preview-token',
    rule: { kind: 'permissions', allOf: [ASSISTANT_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return issuePreviewToken(this.deps, context);
  }
}
