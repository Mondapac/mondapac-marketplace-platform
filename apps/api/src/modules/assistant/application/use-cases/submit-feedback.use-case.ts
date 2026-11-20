import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  submitFeedback,
  type SubmitFeedbackFailure,
  type SubmitFeedbackInput,
} from '../feedback-flow';
import type { Feedback } from '../../domain/feedback';

/**
 * `assistant.submit-feedback`: a signed-in customer's thumbs on an assistant message (rule
 * `own-resources`: the account comes from the session; only its own conversation answers).
 */
export class SubmitFeedback extends UseCase<SubmitFeedbackInput, Feedback, SubmitFeedbackFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.submit-feedback',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: SubmitFeedbackInput) {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' } as const);
    }
    return submitFeedback(
      this.deps,
      context,
      { kind: 'customer', accountId: actor.accountId },
      input,
    );
  }
}
