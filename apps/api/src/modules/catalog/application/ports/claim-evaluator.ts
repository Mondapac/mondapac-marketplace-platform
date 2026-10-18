import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { TagClaimQuery, TagDecision } from '../../domain/offer-tag';

/** The only failure: there is no partial answer, and the caller refuses or keeps (fail closed). */
export interface ClaimCheckUnavailable {
  readonly code: 'claim.check-unavailable';
}

/** The most queries one `evaluate` call may carry (certification design 4.1, CD 4.1). */
export const MAX_CLAIM_QUERIES_PER_CALL = 100;

/**
 * `certification.evaluateClaims` and the Market's active type codes, as catalog consumes them
 * (catalog design 5; ADR-0028). The adapter passes the caller's `CallContext` unchanged and copies
 * each answer field by field into catalog's own types; a refusal, a fault or an answer of the
 * wrong shape is `claim.check-unavailable`, never an empty or allowed answer. Nothing is cached:
 * a decision is valid only in the request that asked. The facade opens its own read-only unit, so
 * callers must not hold a unit of work open (units do not nest).
 */
export interface ClaimEvaluator {
  /** 1 to {@link MAX_CLAIM_QUERIES_PER_CALL} queries; one decision per query, in order. */
  evaluate(
    context: CallContext,
    queries: readonly TagClaimQuery[],
  ): Promise<Result<readonly TagDecision[], ClaimCheckUnavailable>>;

  /** The codes of the Market's active certification types (a new tag names one of them). */
  activeTypeCodes(
    context: CallContext,
  ): Promise<Result<ReadonlySet<string>, ClaimCheckUnavailable>>;

  /**
   * The code of a certification type of the Market by its id, active or not, or null when the
   * Market has no such type (slice 14: certification's events name a type id; tags store the
   * code).
   */
  typeCodeOf(
    context: CallContext,
    typeId: string,
  ): Promise<Result<string | null, ClaimCheckUnavailable>>;
}

export const CLAIM_EVALUATOR = Symbol('CLAIM_EVALUATOR');
