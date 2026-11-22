import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CERTIFICATION_TYPE_EDIT } from '../../../certification';
import { CLAIM_TEXT_CHECK_LIMITS, rateVerdict } from '../../domain/rate-limits';
import { isActingAsSession } from '../acting-as';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  CandidateTerms,
  ClaimTermsCandidateMatcher,
} from '../ports/claim-terms-candidate-matcher';
import { MAX_MATCH_TEXTS, MAX_MATCH_TEXT_LENGTH } from '../ports/claim-text-matcher';
import type {
  ClaimTextImpactReader,
  ImpactTextKind,
  ImpactTextPage,
  ImpactTextRow,
} from '../ports/claim-text-impact.reader';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** The scan stops at this many texts (catalog design 6.5). */
export const IMPACT_COUNT_MAX_TEXTS = 20_000;
/** The scan stops after this many seconds (catalog design 6.5). */
export const IMPACT_COUNT_MAX_SECONDS = 10;
/** Products or Offers read per page. */
export const IMPACT_COUNT_PAGE_ROWS = 50;

export interface ClaimTermsImpactCountInput {
  readonly body: unknown;
}

export interface ClaimTermsImpactCountOutput {
  /** Published products with at least one text the candidate terms would match. */
  readonly products: number;
  /** Published Offers whose description the candidate terms would match. */
  readonly offers: number;
  readonly total: number;
  /** False when the scan stopped at the text or time bound: the numbers are "at least". */
  readonly complete: boolean;
}

export type ClaimTermsImpactCountFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'claim-text.check-unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ClaimTermsImpactCountDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly impactReader: ClaimTextImpactReader;
  readonly candidateMatcher: ClaimTermsCandidateMatcher;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly policy: CatalogMarketPolicy;
  readonly clock: Clock;
}

const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `claim-terms.impact-count` (catalog design 6.5, request C-7): how many PUBLISHED products and
 * Offers a proposed claim term list would match, so the admin sees "N published texts can't be
 * saved again" before saving a certification type. The same scan as the rescan of 6.4 in
 * dry-run mode: synchronous, read-only, bounded at 20,000 texts or 10 seconds (the injected
 * Clock), each text against the candidate terms of every locale, 100 texts per call of
 * `certification.matchCandidateClaimTerms` (request X-1). Beyond the bound it answers
 * `complete: false` with the count so far ("at least N"). A matcher that cannot answer is
 * `claim-text.check-unavailable`, never a zero. Rule: key `certification.type.edit`, imported
 * from `certification`, the admin population, not acting-as. A read-only unit is opened and
 * closed for each page BEFORE the facade is called (units do not nest). Spends the claim-text
 * check budget of the account (30 a minute, 1,000 a day).
 *
 * Counted: product name, short description and description (published revision, every locale);
 * Offer description (published Offers, every locale). Not yet counted: seller and platform
 * category names, attribute definition names and option labels, category-proposal texts (6.4
 * lists them; their readers do not exist yet).
 */
export class ClaimTermsImpactCount extends UseCase<
  ClaimTermsImpactCountInput,
  ClaimTermsImpactCountOutput,
  ClaimTermsImpactCountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.claim-terms-impact-count',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
  };

  readonly #logger = new Logger('ClaimTermsImpactCount');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ClaimTermsImpactCountDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ClaimTermsImpactCountInput,
  ): Promise<Result<ClaimTermsImpactCountOutput, ClaimTermsImpactCountFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) return err({ code: 'access.denied' });
    const candidate = candidateOf(input?.body);
    if (!candidate.ok) return candidate;

    let defaultLocale: string;
    try {
      defaultLocale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const throttled = await this.#reserve(context, actor.accountId);
    if (throttled !== null) return err(throttled);

    // The first call carries no real text: it makes `certification` validate the candidate
    // terms (refused whole, never dropped) even when the Market has nothing published.
    const probe = await this.#match(context, candidate.value, [
      { locale: defaultLocale, text: '' },
    ]);
    if (!probe.ok) return probe;

    const deadline = this.deps.clock.now().add({ seconds: IMPACT_COUNT_MAX_SECONDS });
    const counts: Record<ImpactTextKind, number> = { product: 0, offer: 0 };
    let scanned = 0;
    let complete = true;
    for (const kind of ['product', 'offer'] as const) {
      let afterId: string | null = null;
      do {
        if (this.deps.clock.now().epochMilliseconds >= deadline.epochMilliseconds) {
          complete = false;
          break;
        }
        let page: ImpactTextPage;
        try {
          const read = await this.deps.unitOfWork.run(
            market,
            async () =>
              ok(
                await this.deps.impactReader.page(market, {
                  kind,
                  afterId,
                  limit: IMPACT_COUNT_PAGE_ROWS,
                }),
              ),
            { readOnly: true },
          );
          if (!read.ok) return err({ code: 'access.unavailable' });
          page = read.value;
        } catch {
          return err({ code: 'access.unavailable' });
        }
        // The unit is closed: only now does the scan call `certification`.
        const rows: ImpactTextRow[] = [];
        for (const row of page.rows) {
          if (row.texts.length === 0) continue;
          if (scanned + row.texts.length > IMPACT_COUNT_MAX_TEXTS) {
            complete = false;
            break;
          }
          scanned += row.texts.length;
          rows.push(row);
        }
        const counted = await this.#countRows(context, candidate.value, rows, deadline);
        if (!counted.ok) return counted;
        counts[kind] += counted.value.matched;
        if (counted.value.truncated) complete = false;
        if (!complete) break;
        afterId = page.nextAfterId;
      } while (afterId !== null);
      if (!complete) break;
    }
    this.#logger.log({
      msg: 'catalog.claim-terms-impact-count',
      outcome: complete ? 'complete' : 'bounded',
      scanned,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({
      products: counts.product,
      offers: counts.offer,
      total: counts.product + counts.offer,
      complete,
    });
  }

  /** Matches the texts of the rows in calls of at most 100; a row counts once if any text hits. */
  async #countRows(
    context: CallContext,
    candidate: CandidateTerms,
    rows: readonly ImpactTextRow[],
    deadline: Temporal.Instant,
  ): Promise<Result<{ matched: number; truncated: boolean }, ClaimTermsImpactCountFailure>> {
    const flat: { rowIndex: number; locale: string; text: string }[] = [];
    let truncated = false;
    rows.forEach((row, rowIndex) => {
      for (const { locale, text } of row.texts) {
        if (text.length > MAX_MATCH_TEXT_LENGTH) truncated = true; // the matcher's own cap
        flat.push({ rowIndex, locale, text: text.slice(0, MAX_MATCH_TEXT_LENGTH) });
      }
    });
    const hit = new Set<number>();
    for (let from = 0; from < flat.length; from += MAX_MATCH_TEXTS) {
      // The time bound holds between calls too: a page of many locales is many calls.
      if (this.deps.clock.now().epochMilliseconds >= deadline.epochMilliseconds) {
        truncated = true;
        break;
      }
      const batch = flat.slice(from, from + MAX_MATCH_TEXTS);
      const answer = await this.#match(
        context,
        candidate,
        batch.map(({ locale, text }) => ({ locale, text })),
      );
      if (!answer.ok) return answer;
      answer.value.forEach((matched, index) => {
        if (matched) hit.add(batch[index]!.rowIndex);
      });
    }
    return ok({ matched: hit.size, truncated });
  }

  async #match(
    context: CallContext,
    candidate: CandidateTerms,
    texts: readonly { locale: string; text: string }[],
  ): Promise<Result<readonly boolean[], ClaimTermsImpactCountFailure>> {
    const answer = await this.deps.candidateMatcher.matches(context, candidate, texts);
    if (answer.ok) return answer;
    this.#logger.warn({
      msg: 'catalog.claim-terms-impact-count.matcher-refused',
      code: answer.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(answer.error);
  }

  /** Spends one call of the account's claim-text check budget; null when the call may go on. */
  async #reserve(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<ClaimTermsImpactCountFailure | null> {
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

/** The closed body: `typeCode?` and `termsByLocale` (a map of locale to a list of strings). */
function candidateOf(
  body: unknown,
): Result<CandidateTerms, Extract<ClaimTermsImpactCountFailure, { code: 'validation.failed' }>> {
  if (!isRecord(body)) return invalid('body', 'type');
  for (const key of Object.keys(body)) {
    if (key !== 'typeCode' && key !== 'termsByLocale') return invalid(key.slice(0, 64), 'unknown');
  }
  const { typeCode, termsByLocale } = body;
  if (typeCode !== undefined && typeof typeCode !== 'string') return invalid('typeCode', 'format');
  if (!isRecord(termsByLocale)) return invalid('termsByLocale', 'type');
  const copy: Record<string, readonly string[]> = {};
  for (const [locale, terms] of Object.entries(termsByLocale)) {
    const path = `termsByLocale.${locale.slice(0, 16)}`;
    if (!Array.isArray(terms) || !terms.every((t): t is string => typeof t === 'string')) {
      return invalid(path, 'type');
    }
    copy[locale] = [...terms];
  }
  return ok(typeCode === undefined ? { termsByLocale: copy } : { typeCode, termsByLocale: copy });
}
