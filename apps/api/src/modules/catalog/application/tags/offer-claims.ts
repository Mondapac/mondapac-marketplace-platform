import { err, ok } from '@mondapac/shared-kernel';
import type {
  AuthenticatedActor,
  CallContext,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import type { Offer, OfferState, OfferTagRefusal } from '../../domain/offer';
import {
  canonicalClaimInputs,
  isTagTypeCode,
  type ClaimFacts,
  type TagActor,
  type TagClaimQuery,
  type TagDecision,
} from '../../domain/offer-tag';
import type { ClaimCheckUnavailable, ClaimEvaluator } from '../ports/claim-evaluator';
import { askClaims } from './ask-claims';
import { sha256Hex, type ClaimQueryBuilder } from './claim-query-builder';

/**
 * A lost race restarts a claim-bearing command from its ask, at most this many times, then
 * answers `conflict.retry` (catalog design 5.2 point 3; 5.1a point 6). No decision is kept.
 */
export const MAX_CLAIM_ATTEMPTS = 3;

/** The most types one request may name (`requestedTags`; a Market has a handful of types). */
export const MAX_REQUESTED_TAGS = 20;

/** The tag statuses a write that keeps tags asks again (design 5.2, 5.3). */
const KEPT = new Set(['active', 'rechecking', 'suspended']);

/** The type codes of the tags a write keeps and must ask again (design 5.4 "all tags"). */
export function keptTagTypes(offer: Offer): string[] {
  return offer.tags.filter((tag) => KEPT.has(tag.status)).map((tag) => tag.typeCode);
}

/** The actor of a seller's tag change, for the history row. */
export function sellerTagActor(actor: AuthenticatedActor): TagActor {
  return { kind: 'seller', accountId: actor.accountId };
}

/** What a claim-bearing command asked, kept only until its own unit settles it. */
export interface PreparedAsk {
  readonly facts: ClaimFacts | null;
  readonly queries: ReadonlyMap<string, readonly TagClaimQuery[]>;
}

/**
 * The facts and queries for the given types against the product's published revision, built
 * from the Offer state given (the state after the change). In the caller's unit. `unavailable`
 * when types are named but the product has no readable published revision or the Offer has no
 * handling: nothing can be allowed then (fail closed).
 */
export async function preparePublishedAsk(
  builder: ClaimQueryBuilder,
  market: MarketContext,
  offer: OfferState,
  types: readonly string[],
): Promise<PreparedAsk | 'unavailable'> {
  if (types.length === 0) return { facts: null, queries: new Map() };
  const facts = await builder.publishedFactsOf(market, offer.productId);
  if (facts === null) return 'unavailable';
  const queries = builder.queries(offer, facts, types);
  if (queries === null) return 'unavailable';
  return { facts, queries };
}

/**
 * The hash function a unit passes to the domain: the SHA-256 of each asked query set, computed
 * here, outside the unit (a unit does no hashing, P 3.1 row 5). The domain asks only for the
 * canonical text of inputs equal to what was asked; anything else is a defect and throws.
 */
export function hashesOf(prepared: PreparedAsk): (canonical: string) => string {
  const hashes = new Map<string, string>();
  for (const queries of prepared.queries.values()) {
    if (queries.length === 0) continue;
    const canonical = canonicalClaimInputs(queries);
    hashes.set(canonical, sha256Hex(canonical));
  }
  return (canonical) => {
    const hash = hashes.get(canonical);
    if (hash === undefined) throw new Error('hashesOf: inputs that were not asked');
    return hash;
  };
}

/** Asks for every prepared query outside any unit; no question, no call. */
export async function askPrepared(
  evaluator: ClaimEvaluator,
  context: CallContext,
  prepared: PreparedAsk,
): Promise<Result<Map<string, readonly TagDecision[]>, ClaimCheckUnavailable>> {
  if (prepared.queries.size === 0) return ok(new Map());
  return askClaims(evaluator, context, prepared.queries);
}

/**
 * Parses `requestedTags` (design 5.1a point 6; closed schema): absent is none; otherwise an
 * array of at most {@link MAX_REQUESTED_TAGS} distinct type codes. Nothing about it is stored
 * before the submit.
 */
export function parseRequestedTags(
  value: unknown,
): Result<readonly string[], { readonly path: string; readonly code: string }> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return err({ path: 'requestedTags', code: 'type' });
  if (value.length > MAX_REQUESTED_TAGS) return err({ path: 'requestedTags', code: 'length' });
  const codes: string[] = [];
  for (const code of value as unknown[]) {
    if (!isTagTypeCode(code)) return err({ path: 'requestedTags', code: 'format' });
    if (codes.includes(code)) return err({ path: 'requestedTags', code: 'duplicate' });
    codes.push(code);
  }
  return ok(codes);
}

/** The tag refusals a seller command answers (design 5.2, 5.3; CUX 3.7 reason per type). */
export type TagCommandFailure =
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'tag.product-not-published' }
  | { readonly code: 'tag.exists' }
  | { readonly code: 'tag.not-found' }
  | { readonly code: 'tag.suspended' }
  | { readonly code: 'tag.not-removable' }
  | { readonly code: 'tag.type-unknown' }
  | {
      readonly code: 'claim.tag-not-allowed';
      readonly tags: readonly { readonly typeCode: string; readonly reason: string }[];
    }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'conflict.retry' };

/**
 * A domain tag refusal as the command's failure; `claim.inputs-changed` is never answered (the
 * command asks again) and is mapped by the caller.
 */
export function tagFailureOf(
  refusal: Exclude<OfferTagRefusal, { readonly code: 'claim.inputs-changed' }>,
): TagCommandFailure {
  switch (refusal.code) {
    case 'offer.not-taggable':
      return { code: 'offer.not-found' };
    case 'claim.tag-not-allowed':
      return { code: 'claim.tag-not-allowed', tags: refusal.tags };
    default:
      return { code: refusal.code };
  }
}

/** The signal a unit returns when its decisions are stale: the command asks again. */
export const RETRY = Symbol('retry');
