import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AttributeDefinition, AttributeMergeOption } from '../../domain/attribute-definition';

/**
 * The store the attribute editor writes through (attributes plan, package A2): one definition by
 * id, and its writes by an administrator. Every method runs in the open unit of the use case,
 * through the Market-scoped client. Nothing is ever deleted: a revision is a new insert-only row
 * and the definition's pointer moves to it.
 *
 * A write whose definition changed since it was read (another admin saved first) throws
 * `StaleAggregateError`; the use case answers `attribute.stale`.
 */
export interface AttributeDefinitionStore {
  /** The definition with this id in this Market, built from its current revision, or null. */
  findById(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
  ): Promise<AttributeDefinition | null>;

  /** Whether a definition of this Market already has the code, in any status. */
  codeTaken(market: MarketContext, code: string): Promise<boolean>;

  /**
   * Inserts a draft built by `AttributeDefinition.createDraft`, authored by the account. Throws
   * {@link AttributeCodeTakenError} when the code was taken meanwhile.
   */
  addDraft(
    market: MarketContext,
    definition: AttributeDefinition,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;

  /**
   * Inserts the revision built by `revise` and points the definition at it, if the stored
   * version is still the one before (`version - 1`).
   */
  saveRevision(
    market: MarketContext,
    definition: AttributeDefinition,
    authorAccountId: Id<'Account'>,
    /** The confirmed `clear-material` request the revision applies (catalog design 8.2). */
    relaxationRequestId?: Id<'AttributeRelaxationRequest'>,
  ): Promise<void>;

  /**
   * Locks the definition's row for the rest of the unit if its stored version is `version`, and
   * answers whether it was. The relaxation units take the definition before the request (the lock
   * order of the editor, which cancels an open request after its revision), so they never deadlock.
   */
  lockAtVersion(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
    version: number,
  ): Promise<boolean>;

  /** `true` when another attribute was merged into this one (attributes A8). */
  hasMergedSources(market: MarketContext, id: Id<'AttributeDefinition'>): Promise<boolean>;

  /** Writes the status of `publish` or `discard`, if the stored version is the one before. */
  saveStatus(market: MarketContext, definition: AttributeDefinition): Promise<void>;

  /**
   * Writes the archive of a merge (attributes A8): the status of `source.archive()`, the target it
   * points at and where each of its values goes, if the stored version is the one before.
   */
  saveMerge(
    market: MarketContext,
    source: AttributeDefinition,
    target: Id<'AttributeDefinition'>,
    options: readonly AttributeMergeOption[],
  ): Promise<void>;
}

/** `addDraft` lost a race for the code: another definition of the Market took it first. */
export class AttributeCodeTakenError extends Error {
  override readonly name = 'AttributeCodeTakenError';
  constructor() {
    super('The attribute code is taken');
  }
}

export const ATTRIBUTE_DEFINITION_STORE = Symbol('ATTRIBUTE_DEFINITION_STORE');
