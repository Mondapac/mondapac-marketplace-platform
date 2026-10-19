import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import { viewStorefrontAssistant, type StorefrontAssistantView } from '../settings-flow';

interface Input {
  readonly visitor: unknown;
}

/**
 * `assistant.view-storefront-assistant`: the storefront asks whether to show the assistant to this
 * visitor, without reading a session. It answers the safe subset only: on for this visitor,
 * guests allowed, reply language and welcome text; never limits, caps, model or rollout.
 */
export class ViewStorefrontAssistant extends UseCase<Input, StorefrontAssistantView, never> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.view-storefront-assistant',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewStorefrontAssistant(this.deps, context, input);
  }
}
