import { Logger } from '@nestjs/common';
import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isClaimCheckedFieldId, type ClaimCheckedFieldId } from '../../domain/claim-checked-fields';
import { CLAIM_TEXT_CHECK_LIMITS, rateVerdict } from '../../domain/rate-limits';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import {
  MAX_MATCH_TEXTS,
  MAX_MATCH_TEXT_LENGTH,
  type ClaimTextMatch,
  type ClaimTextMatcher,
} from '../ports/claim-text-matcher';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** The most texts one `claim-text.check` call may carry (design 8.4, proposed). */
export const MAX_CHECK_ENDPOINT_TEXTS = 50;

/** A variant, option or attribute id or code: bounded, so a verdict never echoes a payload. */
const REF = /^[A-Za-z0-9_-]{1,64}$/;

/** The most texts one check call may carry: the panel checks one form, not a catalogue. */
export const MAX_CHECK_TEXTS = 500;

/** One text to check, named by the registry field it sits in (design 6.2). */
export interface CheckedText {
  readonly field: ClaimCheckedFieldId;
  /** The variant or option id the text belongs to, where the field has several (6.1). */
  readonly ref: string | null;
  readonly locale: string;
  readonly text: string;
}

/** Where a verdict applies: the caller's own field, locale and reference, never the text. */
interface Place {
  readonly field: ClaimCheckedFieldId;
  readonly ref: string | null;
  readonly locale: string;
}

/**
 * The verdict on one text (design 6.1, 6.3). `claim-text.found` carries the type codes and spans
 * of the matcher and nothing of the vocabulary; an invisible character carries its offset and
 * kind so the panel can place the cursor (6.3).
 */
export type ClaimTextVerdict = Place &
  (
    | { readonly code: 'clean' }
    | {
        readonly code: 'claim-text.found';
        readonly hits: readonly ClaimTextMatch[];
      }
    | {
        readonly code: 'text.invisible-character';
        readonly offset: number;
        readonly character: 'ZWNJ' | 'ZWJ' | 'other';
      }
    | { readonly code: 'claim-text.check-unavailable' }
  );

export type CheckClaimTextFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface CheckClaimTextDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly matcher: ClaimTextMatcher;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

/**
 * The claim-text check (catalog design 6.1, 6.6; slice 5): an internal service, not a use case.
 * The use cases that write a checked field (`own-product.save-draft` and the others of slices 6
 * and 7) and `claim-text.check` declare their access rule and call it, so it carries no access
 * declaration of its own and derives everything about the caller from the {@link CallContext}.
 *
 * 1. Only a seller (with a seller id) or an admin may ask. The check limit (30 a minute, 1,000 a
 *    day per account) belongs to the use case `claim-text.check` alone: it calls
 *    {@link reserveCheckLimit} first; saves, submits and approvals do not spend it.
 * 2. The request is checked as a whole before anything runs: registered fields only, supported
 *    locales, texts of at most 20,000 characters, at most {@link MAX_CHECK_TEXTS} of them.
 * 3. Per text: a hidden character is refused first (`text.invisible-character`, 6.3), then the
 *    rest go to the matcher in batches of {@link MAX_MATCH_TEXTS}. A batch the matcher cannot
 *    answer, or answers in the wrong shape, makes each of its texts `claim-text.check-unavailable`:
 *    the caller then does not write that text. There is no override and no bypass for anyone.
 *
 * The answer is one verdict per text, in order, so a draft save can refuse per field.
 */
export class CheckClaimText {
  readonly #logger = new Logger('CheckClaimText');

  constructor(private readonly deps: CheckClaimTextDependencies) {}

  async execute(
    context: CallContext,
    texts: readonly CheckedText[],
  ): Promise<Result<readonly ClaimTextVerdict[], CheckClaimTextFailure>> {
    const accountId = accountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });

    const invalid = this.#validate(context, texts);
    if (invalid !== null) return err(invalid);

    const verdicts: (ClaimTextVerdict | null)[] = texts.map(() => null);
    const toMatch: number[] = [];
    texts.forEach((item, index) => {
      const place = placeOf(item);
      const parsed = parsePlainText(item.text);
      if (parsed.ok) toMatch.push(index);
      else verdicts[index] = { ...place, ...parsed.error };
    });

    for (let from = 0; from < toMatch.length; from += MAX_MATCH_TEXTS) {
      const batch = toMatch.slice(from, from + MAX_MATCH_TEXTS);
      const answer = await this.#match(
        context,
        batch.map((index) => texts[index]!),
      );
      batch.forEach((textIndex, position) => {
        const item = texts[textIndex]!;
        const place = placeOf(item);
        const hits = answer?.[position];
        if (hits === undefined) {
          verdicts[textIndex] = { ...place, code: 'claim-text.check-unavailable' };
        } else if (hits.length > 0) {
          verdicts[textIndex] = { ...place, code: 'claim-text.found', hits };
        } else {
          verdicts[textIndex] = { ...place, code: 'clean' };
        }
      });
    }

    const result = verdicts.map((verdict, index) => verdict ?? unavailableAt(texts[index]!));
    this.#logger.log({
      msg: 'catalog.claim-text.check',
      texts: result.length,
      found: result.filter((verdict) => verdict.code === 'claim-text.found').length,
      unavailable: result.filter((verdict) => verdict.code === 'claim-text.check-unavailable')
        .length,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(result);
  }

  /** The matcher's answer for the batch, or `null` when it failed or has the wrong shape. */
  async #match(
    context: CallContext,
    batch: readonly CheckedText[],
  ): Promise<readonly (readonly ClaimTextMatch[])[] | null> {
    try {
      const answer: unknown = await this.deps.matcher.match(
        context,
        batch.map(({ locale, text }) => ({ locale, text })),
      );
      const refused = (reason: 'refused' | 'shape'): null => {
        this.#logger.error({
          msg: 'catalog.claim-text.matcher-failed',
          reason,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
        return null;
      };
      const { ok: answered, value } = answer as { ok?: unknown; value?: unknown };
      if (answered !== true) return refused('refused');
      if (!Array.isArray(value) || value.length !== batch.length) return refused('shape');
      const typed: (readonly ClaimTextMatch[])[] = [];
      for (const list of value as readonly unknown[]) {
        if (!Array.isArray(list) || list.length > MAX_HITS_PER_TEXT) return refused('shape');
        const hits = Array.from(list as readonly unknown[]);
        if (!hits.every(isMatch)) return refused('shape');
        typed.push(hits.map(cleanMatch));
      }
      return typed;
    } catch {
      this.#logger.error({
        msg: 'catalog.claim-text.matcher-failed',
        reason: 'threw',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return null;
    }
  }

  #validate(context: CallContext, texts: readonly CheckedText[]): CheckClaimTextFailure | null {
    const fail = (path: string, code: string): CheckClaimTextFailure => ({
      code: 'validation.failed',
      fields: [{ path, code }],
    });
    if (!Array.isArray(texts)) return fail('texts', 'type');
    if (texts.length > MAX_CHECK_TEXTS) return fail('texts', 'too-many');
    let supported: readonly string[];
    try {
      supported = this.deps.policy.locales(context.market).supported;
    } catch {
      this.#logger.error({
        msg: 'catalog.claim-text.policy-unavailable',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'access.unavailable' };
    }
    for (const [index, entry] of (texts as readonly unknown[]).entries()) {
      // Fixed paths: the seller's own keys and values are never echoed.
      const path = `texts[${index}]`;
      if (typeof entry !== 'object' || entry === null) return fail(path, 'type');
      const item = entry as Record<string, unknown>;
      if (!isClaimCheckedFieldId(item['field'])) return fail(`${path}.field`, 'unknown');
      const itemRef = item['ref'];
      if (itemRef !== null && (typeof itemRef !== 'string' || !REF.test(itemRef))) {
        return fail(`${path}.ref`, 'format');
      }
      const itemLocale = item['locale'];
      if (typeof itemLocale !== 'string' || !supported.includes(itemLocale)) {
        return fail(`${path}.locale`, 'unsupported');
      }
      const itemText = item['text'];
      if (typeof itemText !== 'string') return fail(`${path}.text`, 'type');
      if (itemText.length > MAX_MATCH_TEXT_LENGTH) return fail(`${path}.text`, 'too-long');
    }
    return null;
  }

  /**
   * Counts one `claim-text.check` call against the account's limit (design 6.6, 8.4: 30 a minute,
   * 1,000 a day) and answers the refusal, or `null` when the call may go on. Only the use case
   * `claim-text.check` calls it, before {@link execute}: the checks inside saves, submits and
   * approvals have limits of their own and do not spend this one. A store that cannot answer is
   * `access.unavailable`, never a pass.
   */
  async reserveCheckLimit(
    context: CallContext,
    textCount: number,
  ): Promise<
    | { readonly code: 'access.denied' }
    | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
    | { readonly code: 'access.unavailable' }
    | {
        readonly code: 'validation.failed';
        readonly fields: readonly { readonly path: string; readonly code: string }[];
      }
    | null
  > {
    const accountId = accountOf(context);
    if (accountId === null) return { code: 'access.denied' };
    // The limit counts calls, so a call is capped in texts too: the endpoint is no probe of the
    // vocabulary at 500 texts a call (Hassan M2). The number is a proposal for design 8.4.
    if (!Number.isInteger(textCount) || textCount < 0 || textCount > MAX_CHECK_ENDPOINT_TEXTS) {
      return { code: 'validation.failed', fields: [{ path: 'texts', code: 'too-many' }] };
    }
    const { market } = context;
    try {
      const counters = CLAIM_TEXT_CHECK_LIMITS.map((limit) => ({
        limit,
        keyHash: this.deps.counterKeys.keyOf(market, limit.kind, accountId),
      }));
      const now = this.deps.clock.now();
      const reserved = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.counters.reserve(market, counters, now)),
      );
      if (!reserved.ok) return { code: 'access.unavailable' };
      const verdict = rateVerdict(CLAIM_TEXT_CHECK_LIMITS, reserved.value, now);
      if (verdict.allowed) return null;
      this.#logger.warn({
        msg: 'catalog.request-throttled',
        kinds: CLAIM_TEXT_CHECK_LIMITS.map((limit) => limit.kind),
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
    } catch {
      this.#logger.error({
        msg: 'catalog.rate-counters-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'access.unavailable' };
    }
  }
}

function placeOf({ field, ref, locale }: CheckedText): Place {
  return { field, ref, locale };
}

function unavailableAt(item: CheckedText): ClaimTextVerdict {
  return { ...placeOf(item), code: 'claim-text.check-unavailable' };
}

/** At most this many hits per text; a longer answer is not a matcher's answer. */
const MAX_HITS_PER_TEXT = 100;

function isMatch(value: unknown): value is ClaimTextMatch {
  if (typeof value !== 'object' || value === null) return false;
  const { typeCode, span } = value as { typeCode?: unknown; span?: unknown };
  if (typeof typeCode !== 'string' || typeCode.length === 0) return false;
  if (span === null) return true;
  if (typeof span !== 'object' || span === undefined) return false;
  const { fromToken, toToken } = span as { fromToken?: unknown; toToken?: unknown };
  return (
    typeof fromToken === 'number' &&
    typeof toToken === 'number' &&
    Number.isInteger(fromToken) &&
    Number.isInteger(toToken) &&
    fromToken >= 0 &&
    toToken >= fromToken
  );
}

/** Copies only the two fields the contract has, so nothing else a matcher adds reaches a seller. */
function cleanMatch({ typeCode, span }: ClaimTextMatch): ClaimTextMatch {
  return {
    typeCode,
    span: span === null ? null : { fromToken: span.fromToken, toToken: span.toToken },
  };
}

/** The account of a seller (with a seller id) or an admin; anyone else is nobody here. */
function accountOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated') return null;
  if (actor.population === 'seller') return actor.sellerId === null ? null : actor.accountId;
  if (actor.population === 'admin') return actor.accountId;
  return null;
}
