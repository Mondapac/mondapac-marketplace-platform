import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { ModelBlock, ModelMessage } from '../../../platform/ai/model-provider';
import { DEFAULT_ASSISTANT_SETTINGS, inRollout } from '../domain/assistant-settings';
import type { AssistantSettings } from '../domain/assistant-settings';
import { cardRefOf, type AssistantCard, type AssistantNotice } from '../domain/cards';
import {
  capReached,
  HISTORY_MESSAGES,
  MAX_MODEL_ROUNDS,
  MAX_OUTPUT_TOKENS,
  MAX_TURNS,
  MODEL_TIMEOUT_MS,
  parseConversationId,
  parseMessageText,
  retentionDaysOf,
  TURN_BUDGET_MS,
  type FieldError,
} from '../domain/conversation';
import { instructionsFor } from '../domain/instructions';
import { maskPersonalData } from '../domain/personal-data';
import { guardReply } from '../domain/reply-guard';
import { parseToolCall, TOOL_DECLARATIONS } from '../domain/tools';
import type { AssistantDependencies } from './assistant-dependencies';
import type {
  ConversationOwner,
  ConversationRecord,
  StoredMessage,
} from './ports/conversation.repository';

/** Who is chatting: a signed-in customer (from the session) or a guest (the assistant's cookie). */
export type ChatCaller =
  | { readonly kind: 'customer'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'guest'; readonly token: string | null; readonly origin: string | null };

export interface SendMessageInput {
  readonly conversationId: unknown;
  readonly text: unknown;
  /** The widget's random visitor key, for a percentage rollout (a rollout aid, not a control). */
  readonly visitor: unknown;
}

/** What the buyer is sent, in this order: cards, then the checked sentences, then notices. */
export interface AssistantReply {
  readonly conversationId: string;
  readonly cards: readonly AssistantCard[];
  readonly sentences: readonly string[];
  readonly notices: readonly AssistantNotice[];
  /** A guest's new token, to be set as the assistant cookie; null when nothing changes. */
  readonly guestToken: string | null;
}

export type SendMessageFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /** Off, not configured, or this visitor is not in the rollout (Market settings, R8). */
  | { readonly code: 'assistant.off' }
  /** The Market allows signed-in customers only. */
  | { readonly code: 'assistant.sign-in-required' }
  /** A spend cap is reached: off until the next day or month (plan section 8). */
  | { readonly code: 'assistant.paused' }
  /** No conversation with this id belongs to the caller in this Market. */
  | { readonly code: 'assistant.conversation-not-found' }
  /** The conversation has its 30 buyer messages; the widget starts a new one. */
  | { readonly code: 'assistant.conversation-full' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** The limiter or the store could not be read: fail closed. */
  | { readonly code: 'assistant.unavailable' };

const logger = new Logger('AssistantConversation');

const VISITOR_KEY = /^[A-Za-z0-9_-]{16,64}$/;

const ownerOf = (caller: ChatCaller, guestHash: string | null): ConversationOwner =>
  caller.kind === 'customer'
    ? { kind: 'account', accountId: caller.accountId }
    : { kind: 'guest', tokenHash: guestHash! };

const sameOwner = (a: ConversationOwner, b: ConversationOwner): boolean =>
  a.kind === 'account'
    ? b.kind === 'account' && a.accountId === b.accountId
    : b.kind === 'guest' && a.tokenHash === b.tokenHash;

/** The message limits of plan section 8: per guest token and per origin, or per account. */
function limitSubjects(
  context: CallContext,
  caller: ChatCaller,
  guestHash: string | null,
): string[] {
  const market = context.market.marketId;
  if (caller.kind === 'customer') return [`account:${market}:${caller.accountId}`];
  const subjects = [`origin:${market}:${caller.origin ?? 'unknown'}`];
  if (guestHash !== null) subjects.push(`guest:${market}:${guestHash}`);
  return subjects;
}

async function checkLimits(
  deps: AssistantDependencies,
  subjects: readonly string[],
  limit: number,
): Promise<SendMessageFailure | null> {
  let retryAfterSeconds = 0;
  try {
    for (const subject of subjects) {
      const counted = await deps.limits.count(subject);
      if (counted.count > limit)
        retryAfterSeconds = Math.max(retryAfterSeconds, counted.retryAfterSeconds);
    }
  } catch {
    return { code: 'assistant.unavailable' };
  }
  return retryAfterSeconds > 0 ? { code: 'request.throttled', retryAfterSeconds } : null;
}

interface Turn {
  readonly cards: AssistantCard[];
  readonly notices: Set<AssistantNotice>;
  text: string;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The model loop of one buyer turn, outside any unit of work (ADR-0019 decision 6): the model
 * answers or asks for READ tools, the server runs them with the buyer's own `CallContext` and
 * shows their cards, for at most four calls and 25 seconds. A failed or slow provider ends the
 * turn with the `unavailable` notice and the support card; a refusal with `refused`.
 */
async function runModel(
  deps: AssistantDependencies,
  context: CallContext,
  settings: AssistantSettings,
  history: readonly StoredMessage[],
  text: string,
): Promise<Turn> {
  const turn: Turn = {
    cards: [],
    notices: new Set(),
    text: '',
    costMicroUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const messages: ModelMessage[] = [
    ...history.map((message): ModelMessage => ({
      role: message.role === 'buyer' ? 'user' : 'assistant',
      blocks: [{ type: 'text', text: message.text }],
    })),
    { role: 'user', blocks: [{ type: 'text', text }] },
  ];
  const started = deps.clock.now();
  const supportCard = async () => {
    const outcome = await deps.tools.run(context, { tool: 'support_contact' });
    turn.cards.push(...outcome.cards);
  };

  for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
    const spent = started.until(deps.clock.now()).total({ unit: 'milliseconds' });
    const left = TURN_BUDGET_MS - spent;
    if (left <= 0) {
      turn.notices.add('unavailable');
      break;
    }
    const answer = await deps.runtime.complete(
      context.market.marketId,
      settings.modelTier,
      {
        system: instructionsFor(settings.replyLanguage),
        messages,
        tools: TOOL_DECLARATIONS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
      Math.min(MODEL_TIMEOUT_MS, left),
    );
    if (!answer.ok) {
      turn.notices.add('unavailable');
      await supportCard();
      return turn;
    }
    turn.costMicroUsd += answer.costMicroUsd;
    turn.inputTokens += answer.turn.usage.inputTokens;
    turn.outputTokens += answer.turn.usage.outputTokens;
    turn.text = answer.turn.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    if (answer.turn.stop === 'refusal') {
      turn.text = '';
      turn.notices.add('refused');
      await supportCard();
      return turn;
    }
    const calls = answer.turn.blocks.filter(
      (block): block is Extract<ModelBlock, { type: 'tool-call' }> => block.type === 'tool-call',
    );
    if (answer.turn.stop !== 'tool-use' || calls.length === 0) return turn;

    // Run each requested tool; the model reads the results as data in its next call.
    const results: ModelBlock[] = [];
    for (const call of calls) {
      const request = parseToolCall(call.name, call.input);
      if (request === null) {
        results.push({
          type: 'tool-result',
          callId: call.id,
          content: '{"error":"refused"}',
          isError: true,
        });
        continue;
      }
      const outcome = await deps.tools.run(context, request);
      turn.cards.push(...outcome.cards);
      for (const notice of outcome.notices) turn.notices.add(notice);
      results.push({
        type: 'tool-result',
        callId: call.id,
        content: outcome.forModel,
        isError: outcome.isError,
      });
    }
    messages.push({ role: 'assistant', blocks: answer.turn.blocks });
    messages.push({ role: 'user', blocks: results });
  }
  return turn;
}

/**
 * One buyer message to the assistant and its checked answer (plan sections 2 to 5 and 8; package
 * 4). In order:
 * 1. Input checks; the guest's token from the assistant cookie (a new one if none).
 * 2. A read-only unit: the Market's settings (off, not configured, or out of the rollout:
 *    `assistant.off`; customers only: `assistant.sign-in-required`), the spend against its
 *    caps (`assistant.paused`) and the conversation (owner, turns).
 * 3. The message limits (per guest token and origin, or per account), outside the unit.
 * 4. The model loop, outside any unit, on the masked text and the stored history.
 * 5. The reply guard: no price, stock, delivery or certification claim, inert text only.
 * 6. One read-write unit: the conversation (created on its first message), the turn, the masked
 *    buyer text and the reply (encrypted, only when the retention keeps text), the spend, and
 *    the auto-off record when this turn reached a cap.
 */
export async function sendMessage(
  deps: AssistantDependencies,
  context: CallContext,
  caller: ChatCaller,
  input: SendMessageInput,
): Promise<Result<AssistantReply, SendMessageFailure>> {
  const fields: FieldError[] = [];
  const id = parseConversationId(input?.conversationId);
  if (!id.ok) fields.push(id.error);
  const text = parseMessageText(input?.text);
  if (!text.ok) fields.push(text.error);
  if (!id.ok || !text.ok) return err({ code: 'validation.failed', fields });
  const conversationId = id.value;
  const visitorKey =
    typeof input.visitor === 'string' && VISITOR_KEY.test(input.visitor) ? input.visitor : null;

  // A guest without a usable token gets a new one; it can only start a new conversation.
  let guestHash: string | null = null;
  let issuedToken: string | null = null;
  if (caller.kind === 'guest') {
    guestHash = caller.token === null ? null : deps.guestTokens.hashOf(caller.token);
    if (guestHash === null) {
      const issued = deps.guestTokens.issue();
      guestHash = issued.hash;
      issuedToken = issued.token;
    }
  }
  const owner = ownerOf(caller, guestHash);
  const { market } = context;
  const today = deps.calendar.dayOf(market, deps.clock.now());

  type Loaded = {
    settings: AssistantSettings;
    conversation: ConversationRecord | null;
    history: readonly StoredMessage[];
  };
  const loaded = await deps.unitOfWork.run<Loaded, SendMessageFailure>(
    market,
    async () => {
      const latest = await deps.settings.latest(market);
      const settings = latest?.settings ?? DEFAULT_ASSISTANT_SETTINGS;
      const on =
        settings.enabled &&
        deps.runtime.configured(market.marketId, settings.modelTier) &&
        inRollout(settings, market.marketId, visitorKey);
      if (!on) return err({ code: 'assistant.off' });
      if (caller.kind === 'guest' && settings.users === 'customers-only') {
        return err({ code: 'assistant.sign-in-required' });
      }
      const spend = await deps.spend.totals(market, today);
      if (capReached(settings, spend) !== null) return err({ code: 'assistant.paused' });
      const conversation = await deps.conversations.find(market, conversationId);
      if (conversation !== null) {
        if (!sameOwner(conversation.owner, owner)) {
          return err({ code: 'assistant.conversation-not-found' });
        }
        if (conversation.turns >= MAX_TURNS) return err({ code: 'assistant.conversation-full' });
      }
      const history =
        conversation === null || conversation.retentionDays === 0
          ? []
          : await deps.conversations.history(market, conversationId, HISTORY_MESSAGES);
      return ok({ settings, conversation, history });
    },
    { readOnly: true },
  );
  if (!loaded.ok) return loaded;
  const { settings, conversation, history } = loaded.value;

  const limit =
    caller.kind === 'customer' ? settings.customerMessageLimit : settings.guestMessageLimit;
  const throttled = await checkLimits(
    deps,
    limitSubjects(context, caller, issuedToken === null ? guestHash : null),
    limit,
  );
  if (throttled !== null) return err(throttled);

  const masked = maskPersonalData(text.value);
  const turn = await runModel(deps, context, settings, history, masked);
  const guarded = guardReply(turn.text);
  for (const notice of guarded.notices) turn.notices.add(notice);
  const replyText = guarded.sentences.join(' ');

  const now = deps.clock.now();
  const retentionDays =
    conversation?.retentionDays ??
    retentionDaysOf(settings.retention, caller.kind === 'customer' ? 'customer' : 'guest');
  const written = await deps.unitOfWork.run<{ autoOff: 'daily' | 'monthly' | null }, never>(
    market,
    async () => {
      let counted = true;
      if (conversation === null) {
        counted = await deps.conversations.create(market, {
          id: conversationId,
          owner,
          turns: 0,
          retentionDays,
          startedAt: now,
        });
      }
      counted =
        counted &&
        (await deps.conversations.countTurn(market, conversationId, conversation?.turns ?? 0, now));
      // A turn another request took first is answered but not stored (the cap still holds).
      if (counted && retentionDays > 0) {
        await deps.conversations.append(market, conversationId, {
          role: 'buyer',
          text: masked,
          cards: [],
          at: now,
        });
        await deps.conversations.append(market, conversationId, {
          role: 'assistant',
          text: replyText,
          cards: turn.cards.map(cardRefOf),
          at: now,
        });
      }
      await deps.spend.add(market, today, {
        microUsd: turn.costMicroUsd,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        conversations: conversation === null && counted ? 1 : 0,
      });
      const cap = capReached(settings, await deps.spend.totals(market, today));
      const autoOff =
        cap !== null && (await deps.spend.markAutoOff(market, today, cap, now)) ? cap : null;
      return ok({ autoOff });
    },
  );
  if (written.ok && written.value.autoOff !== null) {
    // The admin notice: the settings screen shows the last auto-off, and this line is the alert.
    logger.warn({
      msg: 'assistant.spend-cap.reached',
      marketId: market.marketId,
      cap: written.value.autoOff,
      correlationId: context.correlationId,
    });
  }

  return ok({
    conversationId,
    cards: turn.cards,
    sentences: guarded.sentences,
    notices: [...turn.notices],
    guestToken: issuedToken,
  });
}
