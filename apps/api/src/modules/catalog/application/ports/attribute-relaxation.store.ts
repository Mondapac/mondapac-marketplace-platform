import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AttributeRelaxationRequest } from '../../domain/attribute-relaxation-request';

/**
 * The two-admin requests to relax a `material` attribute (catalog design 8.2, data design 3.21).
 * Every method runs in the open unit of the use case, through the Market-scoped client. Rows are
 * never deleted: a request's status moves once, out of `open`.
 */
export interface AttributeRelaxationStore {
  /** The request with this id in this Market, or null. */
  findById(
    market: MarketContext,
    id: Id<'AttributeRelaxationRequest'>,
  ): Promise<AttributeRelaxationRequest | null>;

  /** The definition's open request (at most one), expired or not, or null. */
  openOf(
    market: MarketContext,
    definitionId: Id<'AttributeDefinition'>,
  ): Promise<AttributeRelaxationRequest | null>;

  /**
   * Inserts a new open request. Throws {@link RelaxationAlreadyOpenError} when the definition got
   * an open request meanwhile (the open partial unique).
   */
  add(market: MarketContext, request: AttributeRelaxationRequest): Promise<void>;

  /**
   * Writes a status move built by the domain (`version` one above the stored one), only from
   * `open` at the version before. Throws `StaleAggregateError` when another move won.
   */
  saveMove(market: MarketContext, request: AttributeRelaxationRequest): Promise<void>;

  /** Open requests still in time at `now`, oldest first, at most `limit`. */
  listOpen(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AttributeRelaxationRequest[]>;

  /** Open requests whose time ran out at `now`, oldest first, at most `limit` (the expiry job). */
  listExpired(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AttributeRelaxationRequest[]>;
}

/** `add` lost a race: the definition already has an open request. */
export class RelaxationAlreadyOpenError extends Error {
  override readonly name = 'RelaxationAlreadyOpenError';
  constructor() {
    super('The attribute already has an open relaxation request');
  }
}

export const ATTRIBUTE_RELAXATION_STORE = Symbol('ATTRIBUTE_RELAXATION_STORE');
