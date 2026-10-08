import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { rateVerdict, type RateLimit } from '../../domain/rate-limits';
import type { DraftRequirements } from '../../domain/seller-file';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';

// What the seller-side draft use cases (sellers design 6.2: `my-file.*`) share: ownership from
// the actor and the reservation of their rate limits.

const logger = new Logger('SellerDraft');

/** The counter store could not answer: fail closed (6.5, L10). */
export type AccessUnavailable = { readonly code: 'access.unavailable' };
/** A rate limit of design 6.5 is reached. */
export type RequestThrottled = {
  readonly code: 'request.throttled';
  readonly retryAfterSeconds: number;
};
/** The caller is not a seller actor. */
export type DraftAccessDenied = { readonly code: 'access.denied' };
/** The seller's key is destroyed or the read failed: there is no partial answer. */
export type SellersUnavailable = { readonly code: 'sellers.unavailable' };

/** The seller and account a seller-side use case acts for (sellers design 5; AC 18). */
export interface SellerActor {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
}

/**
 * The owner of the request: always `ActorContext.sellerId`, never an id from the request (AC
 * 16, AC 18). Null for any actor that is not an authenticated seller; the gate admits only
 * those under `sellers.business-identity.edit`, so null is a fault of the caller.
 */
export function sellerActorOf(context: CallContext): SellerActor | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return null;
  }
  return { sellerId: actor.sellerId, accountId: actor.accountId };
}

export interface RateLimitDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * Reserves one attempt on each of `limits` for `subject` (data design 3.11), before the work, in
 * a read-write unit of its own: the keys are hashed first (no hashing in a unit), then the
 * repository takes the counters in the fixed order. Over a limit: `request.throttled`, and the
 * attempt keeps its count. A store that errors: `access.unavailable`, never a pass (Hassan L10).
 */
export async function reserveRateLimits(
  deps: RateLimitDependencies,
  context: CallContext,
  limits: readonly RateLimit[],
  subject: string,
): Promise<Result<void, RequestThrottled | AccessUnavailable>> {
  const { market } = context;
  try {
    const counters = limits.map((limit) => ({
      limit,
      keyHash: deps.counterKeys.keyOf(market, limit.kind, subject),
    }));
    const now = deps.clock.now();
    const reserved = await deps.unitOfWork.run(market, async () =>
      ok(await deps.counters.reserve(market, counters, now)),
    );
    if (!reserved.ok) return err({ code: 'access.unavailable' });
    const verdict = rateVerdict(limits, reserved.value, now);
    if (verdict.allowed) return ok(undefined);
    logger.warn({
      msg: 'sellers.request-throttled',
      kinds: limits.map((limit) => limit.kind),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
  } catch {
    logger.error({
      msg: 'sellers.rate-counters-unavailable',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
}

/** The structured line every draft use case writes at its end: ids and codes only (8.3). */
export function logDraftOutcome(
  useCase: string,
  context: CallContext,
  sellerId: Id<'Seller'> | null,
  code: string,
): void {
  logger.log({
    msg: `sellers.${useCase}`,
    code,
    sellerId,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * Whether the seller has a file in the context's Market, read in a read-only unit before any key
 * is used (ADR-0025). A seller id of another Market, or a file not created yet, is then
 * `file.not-found` before the cipher is asked for a key the Market does not hold (AC 1: the same
 * answer as an unknown id). The write unit reads the file again; this read only gates the work.
 */
export async function fileExists(
  deps: { readonly unitOfWork: UnitOfWork; readonly files: SellerFileRepository },
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<boolean> {
  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => ok((await deps.files.findById(market, sellerId)) !== null),
    { readOnly: true },
  );
  return read.ok && read.value;
}

/**
 * What the Market asks of a complete draft (design 3.1, 4.1), from its configuration. Null when
 * the Market has no `sellers` section: the caller answers `sellers.unavailable`, it never judges
 * a draft by another Market's rule.
 */
export function draftRequirementsOf(
  policy: SellerMarketPolicy,
  market: MarketContext,
): DraftRequirements | null {
  const rule = policy.businessIdentifier(market);
  return rule === null
    ? null
    : { identifierRequired: rule.required, identifierScheme: rule.scheme };
}
