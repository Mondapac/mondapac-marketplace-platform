import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  sendMessage,
  type AssistantReply,
  type SendMessageFailure,
  type SendMessageInput,
} from '../conversation-flow';

/**
 * `assistant.send-message`: a signed-in customer's message to the buyer assistant (rule
 * `own-resources`: the account comes from the session, and a conversation answers only its own
 * account). Any other actor is refused.
 */
export class SendMessage extends UseCase<SendMessageInput, AssistantReply, SendMessageFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.send-message',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: SendMessageInput) {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' } as const);
    }
    return sendMessage(this.deps, context, { kind: 'customer', accountId: actor.accountId }, input);
  }
}

export type { AssistantReply } from '../conversation-flow';
