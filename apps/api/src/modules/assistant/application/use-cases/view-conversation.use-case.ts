import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import {
  viewConversation,
  type ConversationTranscript,
  type HistoryFailure,
} from '../history-flow';

/**
 * `assistant.view-conversation`: one of a signed-in customer's own conversations with its stored messages (rule `own-resources`: the account comes from the session; a conversation of
 * another account answers as not found). Any other actor is refused.
 */
export class ViewConversation extends UseCase<
  { readonly conversationId: unknown },
  ConversationTranscript,
  HistoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.view-conversation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly conversationId: unknown }) {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' } as const);
    }
    return viewConversation(this.deps, context, actor.accountId, input);
  }
}

export type { ConversationTranscript } from '../history-flow';
