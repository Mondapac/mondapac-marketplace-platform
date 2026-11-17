import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AssistantDependencies } from '../assistant-dependencies';
import { deleteConversation, type DeletedConversation, type HistoryFailure } from '../history-flow';

/**
 * `assistant.delete-conversation`: a signed-in customer deletes one of their own conversations and its key (rule `own-resources`: the account comes from the session; a conversation of
 * another account answers as not found). Any other actor is refused.
 */
export class DeleteConversation extends UseCase<
  { readonly conversationId: unknown },
  DeletedConversation,
  HistoryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.delete-conversation',
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
    return deleteConversation(this.deps, context, actor.accountId, input);
  }
}
