import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  sendMessage,
  type AssistantReply,
  type SendMessageFailure,
  type SendMessageInput,
} from '../conversation-flow';

type Input = SendMessageInput & {
  /** The assistant guest cookie's token, or null. */
  readonly token: string | null;
  /** The client origin (IPv4 address or IPv6 /64), for the per-origin message limit. */
  readonly origin: string | null;
};

/**
 * `assistant.send-guest-message`: a guest's message to the buyer assistant (rule `anonymous`, no
 * session read). The guest is the assistant's own cookie token, never the behaviour or cart
 * cookie (plan section 4); a conversation answers only the token that started it.
 */
export class SendGuestMessage extends UseCase<Input, AssistantReply, SendMessageFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.send-guest-message',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return sendMessage(
      this.deps,
      context,
      { kind: 'guest', token: input.token, origin: input.origin },
      input,
    );
  }
}
