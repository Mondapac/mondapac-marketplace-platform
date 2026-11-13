import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isActingAsSession } from '../acting-as';
import {
  draftText,
  guardDraft,
  type DraftSentence,
} from '../../domain/description-writer/draft-guard';
import {
  WRITER_PROMPT_VERSION,
  writerFacts,
  writerInput,
  writerInstructions,
} from '../../domain/description-writer/writer-prompt';
import {
  parseWriterRequest,
  type WriterFieldIssue,
} from '../../domain/description-writer/writer-request';
import {
  ADMIN_AI_DRAFT_LIMITS,
  SELLER_AI_DRAFT_LIMITS,
  rateVerdict,
  type RateLimit,
} from '../../domain/rate-limits';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { MAX_MATCH_TEXTS } from '../ports/claim-text-matcher';
import type {
  DescriptionWriterModel,
  DescriptionWriterSwitches,
  MarketDayCalendar,
  WriterModelTier,
} from '../ports/description-writer';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** A provider that has not answered by then is cut (the modal shows "We couldn't write a draft."). */
export const WRITER_TIMEOUT_MS = 25_000;
/** Enough for about 150 words and a margin; the guard cuts the kept text at its own bound. */
export const WRITER_MAX_OUTPUT_TOKENS = 700;

export interface DescriptionWriterDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
  readonly matcher: ClaimTextMatcher;
  readonly model: DescriptionWriterModel;
  readonly switches: DescriptionWriterSwitches;
  readonly calendar: MarketDayCalendar;
}

/** Who asks: a seller's account for its own product, or an admin for a platform product. */
export type WriterCaller =
  | {
      readonly kind: 'seller';
      readonly accountId: Id<'Account'>;
      readonly sellerId: Id<'Seller'>;
    }
  | { readonly kind: 'admin'; readonly accountId: Id<'Account'> };

export interface WriterAvailability {
  readonly available: boolean;
  /** The Market's zone, for "They reset at midnight <zone> time." */
  readonly resetZone: string;
}

export interface WriterDraft {
  /** Plain text: sentences, paragraphs split by a blank line. Never markup. */
  readonly text: string;
  /** How many sentences the server left out, and why. */
  readonly leftOut: { readonly certification: number; readonly other: number };
  readonly promptVersion: string;
}

export type WriterFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.acting-as-refused' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'validation.failed'; readonly fields: readonly WriterFieldIssue[] }
  /** The writer is off for the Market or the seller, or no model is set: the button is hidden. */
  | { readonly code: 'ai.writer-off' }
  /** Today's drafts are used up; they come back at the Market's next midnight. */
  | {
      readonly code: 'ai.limit-reached';
      readonly retryAfterSeconds: number;
      readonly resetZone: string;
    }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** The provider failed, timed out or stopped early, or the claim check could not run. */
  | { readonly code: 'ai.writer-failed' }
  /** Every sentence of the draft was left out. */
  | {
      readonly code: 'ai.draft-withheld';
      readonly leftOut: { readonly certification: number; readonly other: number };
    };

const logger = new Logger('DescriptionWriter');

/** The caller as the access rule already admitted it, or null (wrong population, no seller). */
export function writerCallerOf(
  context: CallContext,
  kind: WriterCaller['kind'],
): WriterCaller | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated') return null;
  if (kind === 'admin') {
    return actor.population === 'admin' ? { kind: 'admin', accountId: actor.accountId } : null;
  }
  if (actor.population !== 'seller' || actor.sellerId === null) return null;
  return { kind: 'seller', accountId: actor.accountId, sellerId: actor.sellerId };
}

/**
 * Both switches and the model (ADR-0019 decision 7, R8): the Market's switch and tier, the seller's
 * switch for a seller, and a configured model for that tier. Any error is off.
 */
async function tierIfOn(
  deps: DescriptionWriterDependencies,
  context: CallContext,
  caller: WriterCaller,
): Promise<WriterModelTier | null> {
  try {
    const market = await deps.switches.market(context);
    if (!market.enabled) return null;
    if (caller.kind === 'seller' && !(await deps.switches.seller(context, caller.sellerId))) {
      return null;
    }
    return deps.model.configured(context.market, market.tier) ? market.tier : null;
  } catch {
    return null;
  }
}

/** Whether the writer may be offered now: the panel hides "Write with AI" when not. */
export async function writerAvailability(
  deps: DescriptionWriterDependencies,
  context: CallContext,
  kind: WriterCaller['kind'],
): Promise<Result<WriterAvailability, WriterFailure>> {
  const caller = writerCallerOf(context, kind);
  if (caller === null) return err({ code: 'access.denied' });
  const resetZone = deps.calendar.zoneOf(context.market);
  // No AI in an acting-as session (R3): the button is simply not offered there.
  if (isActingAsSession(context.actor)) return ok({ available: false, resetZone });
  return ok({ available: (await tierIfOn(deps, context, caller)) !== null, resetZone });
}

/**
 * Counts one draft on the caller's counters. The day counters are keyed with the Market's date,
 * so they end at the Market's midnight whatever their 24-hour window says; the refusal then says
 * how long until that midnight. A store that cannot count is `access.unavailable` (no free call).
 */
async function reserveDraft(
  deps: DescriptionWriterDependencies,
  context: CallContext,
  caller: WriterCaller,
): Promise<WriterFailure | null> {
  const { market } = context;
  const now = deps.clock.now();
  const day = deps.calendar.dayOf(market, now);
  const limits: readonly RateLimit[] =
    caller.kind === 'seller' ? SELLER_AI_DRAFT_LIMITS : ADMIN_AI_DRAFT_LIMITS;
  const subjectOf = (limit: RateLimit): string => {
    if (limit.kind === 'ai-suggest.seller.day' && caller.kind === 'seller') {
      return `${caller.sellerId}|${day}`;
    }
    if (limit.kind === 'ai-suggest.account.day') return `${caller.accountId}|${day}`;
    return caller.accountId;
  };
  try {
    const counters = limits.map((limit) => ({
      limit,
      keyHash: deps.counterKeys.keyOf(market, limit.kind, subjectOf(limit)),
    }));
    const reserved = await deps.unitOfWork.run(market, async () =>
      ok(await deps.counters.reserve(market, counters, now)),
    );
    if (!reserved.ok) return { code: 'access.unavailable' };
    const verdict = rateVerdict(limits, reserved.value, now);
    if (verdict.allowed) return null;
    const dayLimit = limits.find((limit) => limit.kind.endsWith('.day'));
    const dayCount = reserved.value.find((r) => r.kind === dayLimit?.kind)?.count ?? 0;
    if (dayLimit !== undefined && dayCount > dayLimit.limit) {
      const midnight = deps.calendar.nextMidnight(market, now);
      return {
        code: 'ai.limit-reached',
        retryAfterSeconds: Math.max(1, Math.ceil(now.until(midnight).total({ unit: 'seconds' }))),
        resetZone: deps.calendar.zoneOf(market),
      };
    }
    return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
  } catch {
    return { code: 'access.unavailable' };
  }
}

/**
 * One draft (AIS-03; catalog design 13.1 as changed for the modal). Order: who (population, not
 * acting-as), the body, both switches and the model, the limit, then the model call outside any
 * unit of work, then the guard and the Market's claim vocabulary on every kept sentence. Nothing
 * is stored and no domain record changes (R4): the panel puts the text into the field only on
 * "Use text", and it is saved only with the form, through the same server claim refusal as typed
 * text. The log carries codes and counts only, never a text.
 */
export async function writeDescriptionDraft(
  deps: DescriptionWriterDependencies,
  context: CallContext,
  kind: WriterCaller['kind'],
  body: unknown,
): Promise<Result<WriterDraft, WriterFailure>> {
  const result = await draft(deps, context, kind, body);
  logger.log({
    msg: 'catalog.description-writer',
    caller: kind,
    outcome: result.ok ? 'drafted' : result.error.code,
    ...(result.ok ? { leftOut: result.value.leftOut } : {}),
    promptVersion: WRITER_PROMPT_VERSION,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}

async function draft(
  deps: DescriptionWriterDependencies,
  context: CallContext,
  kind: WriterCaller['kind'],
  body: unknown,
): Promise<Result<WriterDraft, WriterFailure>> {
  const caller = writerCallerOf(context, kind);
  if (caller === null) return err({ code: 'access.denied' });
  if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
  const request = parseWriterRequest(body);
  if (!request.ok) return err({ code: 'validation.failed', fields: request.error });

  const tier = await tierIfOn(deps, context, caller);
  if (tier === null) return err({ code: 'ai.writer-off' });
  const refused = await reserveDraft(deps, context, caller);
  if (refused !== null) return err(refused);

  const answer = await deps.model.write(
    context.market,
    tier,
    {
      system: writerInstructions(request.value.tone, request.value.length),
      input: writerInput(request.value),
      maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
    },
    WRITER_TIMEOUT_MS,
  );
  if (!answer.ok) {
    return err(
      answer.failure === 'not-configured'
        ? { code: 'ai.writer-off' }
        : { code: 'ai.writer-failed' },
    );
  }

  const guarded = guardDraft(answer.text, writerFacts(request.value));
  // The Market's claim vocabulary on each kept sentence (CAT-41 terms of every type and locale).
  // A matcher that cannot answer, or answers in another shape, means no draft (fail closed).
  const kept: DraftSentence[] = [];
  let certification = guarded.leftOut.certification;
  for (let from = 0; from < guarded.sentences.length; from += MAX_MATCH_TEXTS) {
    const batch = guarded.sentences.slice(from, from + MAX_MATCH_TEXTS);
    let matches;
    try {
      matches = await deps.matcher.match(
        context,
        batch.map((sentence) => ({ locale: 'en', text: sentence.text })),
      );
    } catch {
      return err({ code: 'ai.writer-failed' });
    }
    if (!matches.ok || !Array.isArray(matches.value) || matches.value.length !== batch.length) {
      return err({ code: 'ai.writer-failed' });
    }
    for (const [index, sentence] of batch.entries()) {
      const hits: unknown = matches.value[index];
      if (!Array.isArray(hits)) return err({ code: 'ai.writer-failed' });
      if (hits.length > 0) certification += 1;
      else kept.push(sentence);
    }
  }
  const leftOut = { certification, other: guarded.leftOut.other };
  if (kept.length === 0) return err({ code: 'ai.draft-withheld', leftOut });
  return ok({ text: draftText(kept), leftOut, promptVersion: WRITER_PROMPT_VERSION });
}
