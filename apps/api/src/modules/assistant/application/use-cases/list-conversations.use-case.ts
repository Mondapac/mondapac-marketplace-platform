import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import { listConversations, type ConversationPage, type HistoryFailure } from '../history-flow';

/**
 * `assistant.list-conversations`: a signed-in customer's own conversations with the assistant, newest first, within the retention in force (rule `own-resources`: the account comes from the session; a conversation of
 * another account answers as not found). Any other actor is refused.
 */
export class ListConversations extends UseCase<
  { readonly cursor?: unknown; readonly limit?: unknown },
  ConversationPage,
  HistoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.list-conversations',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly cursor?: unknown; readonly limit?: unknown },
  ) {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' } as const);
    }
    return listConversations(this.deps, context, actor.accountId, input);
  }
}

export type { ConversationListItem, ConversationPage } from '../history-flow';
