import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Feedback } from '../../domain/feedback';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  submitFeedback,
  type SubmitFeedbackFailure,
  type SubmitFeedbackInput,
} from '../feedback-flow';

type Input = SubmitFeedbackInput & {
  /** The assistant guest cookie's token, or null. */
  readonly token: string | null;
};

/**
 * `assistant.submit-guest-feedback`: a guest's thumbs on an assistant message (rule `anonymous`,
 * no session read). The guest is the assistant's own cookie token, and the conversation must be
 * the one that token started; a missing or unknown token is the same 404 as an unknown id.
 */
export class SubmitGuestFeedback extends UseCase<Input, Feedback, SubmitFeedbackFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.submit-guest-feedback',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return submitFeedback(this.deps, context, { kind: 'guest', token: input.token }, input);
  }
}
