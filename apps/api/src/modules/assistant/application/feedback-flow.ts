import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { DEFAULT_ASSISTANT_SETTINGS } from '../domain/assistant-settings';
import { parseConversationId, type FieldError } from '../domain/conversation';
import { parseFeedback, parseMessagePosition, type Feedback } from '../domain/feedback';
import type { AssistantDependencies } from './assistant-dependencies';

/** Who gives the thumbs: a signed-in customer (the session) or a guest (the assistant's cookie). */
export type FeedbackCaller =
  | { readonly kind: 'customer'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'guest'; readonly token: string | null };

export interface SubmitFeedbackInput {
  readonly conversationId: unknown;
  readonly messageId: unknown;
  readonly rating: unknown;
  readonly reason: unknown;
}

export type SubmitFeedbackFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /** The Market's assistant is switched off. */
  | { readonly code: 'assistant.off' }
  /** The Market allows signed-in customers only: a guest's thumbs are refused too. */
  | { readonly code: 'assistant.sign-in-required' }
  /** No conversation with this id belongs to the caller in this Market. */
  | { readonly code: 'assistant.conversation-not-found' }
  /** The conversation has no assistant message at that position (or keeps no text). */
  | { readonly code: 'assistant.message-not-found' };

/**
 * A buyer's thumbs on one assistant message (B3). The caller must own the conversation (account
 * from the session, or the guest cookie's token hash); anything else is the same 404 as an
 * unknown id. One row per message: giving feedback again replaces the earlier one.
 */
export async function submitFeedback(
  deps: AssistantDependencies,
  context: CallContext,
  caller: FeedbackCaller,
  input: SubmitFeedbackInput,
): Promise<Result<Feedback, SubmitFeedbackFailure>> {
  const fields: FieldError[] = [];
  const id = parseConversationId(input.conversationId);
  if (!id.ok) fields.push(id.error);
  const position = parseMessagePosition(input.messageId);
  if (!position.ok) fields.push(position.error);
  const feedback = parseFeedback({ rating: input.rating, reason: input.reason });
  if (!feedback.ok) fields.push(...feedback.error);
  if (!id.ok || !position.ok || !feedback.ok) return err({ code: 'validation.failed', fields });

  const { market } = context;
  const guestHash =
    caller.kind === 'guest' && caller.token !== null ? deps.guestTokens.hashOf(caller.token) : null;
  if (caller.kind === 'guest' && guestHash === null) {
    return err({ code: 'assistant.conversation-not-found' });
  }
  const now = deps.clock.now();

  return deps.unitOfWork.run<Feedback, SubmitFeedbackFailure>(market, async () => {
    const settings = (await deps.settings.latest(market))?.settings ?? DEFAULT_ASSISTANT_SETTINGS;
    if (!settings.enabled) return err({ code: 'assistant.off' });
    if (caller.kind === 'guest' && settings.users === 'customers-only') {
      return err({ code: 'assistant.sign-in-required' });
    }
    const conversation = await deps.conversations.find(market, id.value);
    const owned =
      conversation !== null &&
      (caller.kind === 'customer'
        ? conversation.owner.kind === 'account' && conversation.owner.accountId === caller.accountId
        : conversation.owner.kind === 'guest' && conversation.owner.tokenHash === guestHash);
    if (!owned) return err({ code: 'assistant.conversation-not-found' });
    const saved = await deps.feedback.save(market, id.value, position.value, feedback.value, now);
    return saved ? ok(feedback.value) : err({ code: 'assistant.message-not-found' });
  });
}
