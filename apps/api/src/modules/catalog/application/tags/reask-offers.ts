import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Offer } from '../../domain/offer';
import type { OfferTagState, TagDecision, TagEntryPath } from '../../domain/offer-tag';
import { CategoryPathsUnavailableError } from '../ports/category-paths.reader';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { OfferRepository } from '../ports/offer.repository';
import type { ReevaluationCounts } from '../ports/tag-reevaluation-requests';
import { askClaimsMany } from './ask-claims';
import type { ClaimQueryBuilder, PublishedSnapshot } from './claim-query-builder';
import {
  claimsFailClosed,
  factsInUnit,
  hashesOf,
  keptTagTypes,
  RETRY,
  type PreparedAsk,
} from './offer-claims';

/**
 * The re-ask of a page of Offers by the system actor (catalog design 5.5, 5.6; slice 12): the
 * certification-event handlers and the daily reconciliation. Shared so both paths are the same
 * control:
 *
 * 1. optionally (an expired or revoked certificate, 5.5) the selected `active` tags are marked
 *    `rechecking`, one unit per Offer, so no badge is shown while the answer is unknown;
 * 2. a read-only unit reads the Offers and builds, for every kept tag (`active`, `rechecking`,
 *    `suspended`), the queries against the product's published revision;
 * 3. one batched ask outside any unit (at most 100 queries a call);
 * 4. each Offer settled in its own unit under the version it was read at, with the product locked
 *    at the version asked about (`factsInUnit`): allowed is `active` (kept, restored or switched),
 *    refused is `suspended` (off sale, CERT-15).
 *
 * Fail closed (5.2 point 4): an unanswered ask, or an `unavailable` answer for an Offer, changes
 * no tag to `active`; the selected `active` tags of those Offers are marked `rechecking` (no
 * badge) and the page is reported incomplete, so the caller asks again. A `suspended` tag stays
 * `suspended` until a fresh allowed answer (AC 13). A lost race (the Offer or product moved) is
 * incomplete too and changes nothing: the next run reads it again.
 */
export interface ReaskDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly claims: ClaimQueryBuilder;
  readonly evaluator: ClaimEvaluator;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

export interface ReaskOptions {
  readonly entryPath: Extract<TagEntryPath, 'certification-event' | 'reconciliation'>;
  /** The consumed event, recorded on the history rows; null for the reconciliation. */
  readonly causeEventId: Id | null;
  /** The tags of an Offer the cause selected: marked `rechecking` first and on failure. */
  readonly selects: (tag: OfferTagState) => boolean;
  /** Mark the selected `active` tags `rechecking` before asking (expired, revoked). */
  readonly markFirst: boolean;
}

export interface ReaskPageOutcome {
  readonly counts: ReevaluationCounts;
  /** False when an Offer of the page was left for a later run (unanswered or a lost race). */
  readonly complete: boolean;
  /** The Offers of the page that could not be asked at all (no published revision, no handling). */
  readonly skipped: readonly Id<'Offer'>[];
  /**
   * True when the page as a whole went unanswered (the batched ask failed, or its queries could
   * not be built): certification is down, not one Offer's answer.
   */
  readonly batchFailed: boolean;
  /** The Offers answered `unavailable` one by one (their selected tags marked `rechecking`). */
  readonly unavailableOffers: readonly Id<'Offer'>[];
}

const SYSTEM = { kind: 'system', accountId: null } as const;

const NONE: ReevaluationCounts = {
  asked: 0,
  kept: 0,
  switched: 0,
  suspended: 0,
  restored: 0,
  unavailable: 0,
};

/** One Offer of the page as read: what to ask, or why nothing can be asked. */
interface PreparedOffer {
  readonly offerId: Id<'Offer'>;
  readonly version: number;
  readonly prepared: PreparedAsk | null;
}

type SettleOutcome =
  | {
      readonly kept: number;
      readonly switched: number;
      readonly suspended: number;
      readonly restored: number;
    }
  | typeof RETRY
  | 'unavailable';

export async function reaskOffers(
  deps: ReaskDependencies,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
  options: ReaskOptions,
): Promise<ReaskPageOutcome> {
  if (offerIds.length === 0) {
    return { counts: NONE, complete: true, skipped: [], batchFailed: false, unavailableOffers: [] };
  }
  if (options.markFirst) await markRechecking(deps, context, offerIds, options);

  const read = await prepare(deps, context, offerIds);
  if (read === 'unavailable') {
    await markRechecking(deps, context, offerIds, options);
    return {
      counts: { ...NONE, unavailable: offerIds.length },
      complete: false,
      skipped: [],
      batchFailed: true,
      unavailableOffers: [],
    };
  }
  const asking = read.filter((item) => item.prepared !== null);
  const skipped = read.filter((item) => item.prepared === null).map((item) => item.offerId);
  const queryCount = asking.reduce(
    (sum, item) => sum + [...item.prepared!.queries.values()].reduce((n, qs) => n + qs.length, 0),
    0,
  );
  const asked =
    asking.length === 0
      ? ok([])
      : await askClaimsMany(
          deps.evaluator,
          context,
          asking.map((item) => item.prepared!.queries),
        );
  if (!asked.ok) {
    await markRechecking(
      deps,
      context,
      asking.map((item) => item.offerId),
      options,
    );
    return {
      counts: { ...NONE, unavailable: queryCount },
      complete: false,
      skipped,
      batchFailed: true,
      unavailableOffers: [],
    };
  }
  let counts: ReevaluationCounts = { ...NONE, asked: queryCount };
  let complete = true;
  const failed: Id<'Offer'>[] = [];
  for (const [i, item] of asking.entries()) {
    const settled = await settleOne(deps, context, item, asked.value[i]!, options);
    if (settled === RETRY) {
      complete = false;
      continue;
    }
    if (settled === 'unavailable') {
      complete = false;
      failed.push(item.offerId);
      counts = { ...counts, unavailable: counts.unavailable + 1 };
      continue;
    }
    counts = {
      ...counts,
      kept: counts.kept + settled.kept,
      switched: counts.switched + settled.switched,
      suspended: counts.suspended + settled.suspended,
      restored: counts.restored + settled.restored,
    };
  }
  if (failed.length > 0) await markRechecking(deps, context, failed, options);
  return { counts, complete, skipped, batchFailed: false, unavailableOffers: failed };
}

/** Adds one page's counts to a running total. */
export function addCounts(a: ReevaluationCounts, b: ReevaluationCounts): ReevaluationCounts {
  return {
    asked: a.asked + b.asked,
    kept: a.kept + b.kept,
    switched: a.switched + b.switched,
    suspended: a.suspended + b.suspended,
    restored: a.restored + b.restored,
    unavailable: a.unavailable + b.unavailable,
  };
}

/** Tries per Offer: the first read, and one fresh read after a lost race (Hassan L-1). */
const MARK_ATTEMPTS = 2;

/**
 * The selected `active` tags of these Offers become `rechecking` (no badge), each Offer in its own
 * unit (Hassan L-1, PR #398): a lost race on one Offer never rolls back the others. A lost race is
 * tried once more on a fresh read; if it is lost again, the Offer was just written by another unit
 * (which asked about it itself) and the next run reads it again. A deleted Offer marks nothing.
 * Returns the number of tags marked.
 */
export async function markRechecking(
  deps: Pick<ReaskDependencies, 'unitOfWork' | 'offers' | 'clock'>,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
  options: Pick<ReaskOptions, 'entryPath' | 'causeEventId' | 'selects'>,
): Promise<number> {
  const { market } = context;
  let total = 0;
  for (const offerId of offerIds) {
    for (let attempt = 1; attempt <= MARK_ATTEMPTS; attempt += 1) {
      try {
        const marked = await deps.unitOfWork.run(market, async () => {
          const offer = await deps.offers.findById(market, offerId);
          if (offer === null) return ok(0);
          const tagIds = selectedTagIds(offer, options);
          if (tagIds.size === 0) return ok(0);
          const count = offer.markRechecking({
            entryPath: options.entryPath,
            actor: SYSTEM,
            now: deps.clock.now(),
            tagIds,
            causeEventId: options.causeEventId,
          });
          if (count > 0) await deps.offers.save(market, offer, SYSTEM);
          return ok(count);
        });
        if (marked.ok) total += marked.value;
        break;
      } catch (error) {
        if (!(error instanceof StaleAggregateError)) throw error;
      }
    }
  }
  return total;
}

function selectedTagIds(offer: Offer, options: Pick<ReaskOptions, 'selects'>): Set<string> {
  return new Set(
    offer.tags
      .filter((tag) => tag.status === 'active' && options.selects(tag))
      .map((tag) => tag.id as string),
  );
}

/**
 * A read-only unit: each Offer's kept tags and the queries against its product's published
 * revision (read once per product). `unavailable` when a category path cannot be built (fail
 * closed, M3). An Offer that is deleted, has no kept tag, has no handling or whose product has no
 * readable published revision gets no question (`prepared: null`).
 */
async function prepare(
  deps: ReaskDependencies,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
): Promise<readonly PreparedOffer[] | 'unavailable'> {
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run<readonly PreparedOffer[], never>(
      market,
      async () => {
        const offers = await deps.offers.findManyByIds(market, offerIds);
        const snapshots = new Map<string, PublishedSnapshot>();
        const out: PreparedOffer[] = [];
        for (const offer of offers) {
          const types = keptTagTypes(offer);
          if (offer.state.status === 'deleted' || types.length === 0) continue;
          const productId = offer.state.productId;
          let snapshot = snapshots.get(productId);
          if (snapshot === undefined) {
            snapshot = await deps.claims.publishedSnapshot(market, productId);
            snapshots.set(productId, snapshot);
          }
          const queries =
            snapshot.facts === null
              ? null
              : deps.claims.queries(offer.state, snapshot.facts, types);
          out.push({
            offerId: offer.state.id,
            version: offer.state.version,
            prepared:
              queries === null || snapshot.productVersion === null
                ? null
                : { facts: snapshot.facts, queries, productVersion: snapshot.productVersion },
          });
        }
        return ok(out);
      },
      { readOnly: true },
    );
    return read.ok ? read.value : 'unavailable';
  } catch (error) {
    if (error instanceof CategoryPathsUnavailableError) return 'unavailable';
    throw error;
  }
}

/**
 * One Offer in its own unit: read again at the version the ask was built on, the product locked at
 * the version asked about, the kept tags settled on these decisions.
 */
async function settleOne(
  deps: ReaskDependencies,
  context: CallContext,
  item: PreparedOffer,
  decisions: ReadonlyMap<string, readonly TagDecision[]>,
  options: ReaskOptions,
): Promise<SettleOutcome> {
  const { market } = context;
  const prepared = item.prepared!;
  const hash = hashesOf(prepared);
  try {
    const outcome = await claimsFailClosed(() =>
      deps.unitOfWork.run<
        Exclude<SettleOutcome, 'unavailable'>,
        { readonly code: 'claim.check-unavailable' }
      >(market, async () => {
        const offer = await deps.offers.findById(market, item.offerId);
        if (offer === null || offer.state.status === 'deleted') {
          return ok({ kept: 0, switched: 0, suspended: 0, restored: 0 });
        }
        if (offer.state.version !== item.version) return ok(RETRY);
        const facts = await factsInUnit(deps.claims, market, offer.state.productId, prepared);
        if (facts === RETRY) return ok(RETRY);
        const settled = offer.settleTags({
          facts,
          decisions,
          entryPath: options.entryPath,
          actor: SYSTEM,
          hash,
          now: deps.clock.now(),
          causeEventId: options.causeEventId,
        });
        if (!settled.ok) {
          return settled.error.code === 'claim.inputs-changed'
            ? ok(RETRY)
            : err({ code: 'claim.check-unavailable' } as const);
        }
        await deps.offers.save(market, offer, SYSTEM);
        await deps.outbox.append(context, offer.pendingEvents);
        return ok(settled.value);
      }),
    );
    return outcome.ok ? outcome.value : 'unavailable';
  } catch (error) {
    if (error instanceof StaleAggregateError) return RETRY;
    throw error;
  }
}
