import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AttributeFamily } from '../../domain/attribute-family';

/**
 * The store the feature-set editor writes through (attributes plan, package A4): one family by id
 * and its writes by an administrator. Every method runs in the open unit of the use case, through
 * the Market-scoped client. Nothing is deleted: a revision is a new insert-only row and the
 * family's pointer moves to it. A write whose family changed since it was read throws
 * `StaleAggregateError`; the use case answers `feature-set.stale`.
 */
export interface FeatureSetStore {
  /** The family with this id in this Market, built from its current revision, or null. */
  findById(market: MarketContext, id: Id<'AttributeFamily'>): Promise<AttributeFamily | null>;

  /** Whether a family of this Market already has the code, in any status. */
  codeTaken(market: MarketContext, code: string): Promise<boolean>;

  /**
   * Inserts a family built by `AttributeFamily.createByAdmin`, authored by the account. Throws
   * {@link FeatureSetCodeTakenError} when the code was taken meanwhile.
   */
  addNew(
    market: MarketContext,
    family: AttributeFamily,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;

  /**
   * Inserts the revision built by `revise` and points the family at it, if the stored version
   * is still the one before (`version - 1`).
   */
  saveRevision(
    market: MarketContext,
    family: AttributeFamily,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;
}

/** `addNew` lost a race for the code: another family of the Market took it first. */
export class FeatureSetCodeTakenError extends Error {
  override readonly name = 'FeatureSetCodeTakenError';
  constructor() {
    super('The feature set code is taken');
  }
}

export const FEATURE_SET_STORE = Symbol('FEATURE_SET_STORE');
