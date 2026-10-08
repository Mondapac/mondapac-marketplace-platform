import type { AttributeSchema, Id, MarketContext } from '@mondapac/shared-kernel';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import type { AttributeFamily } from '../../domain/attribute-family';

/**
 * The store of attribute definitions and families (catalog data design 3.5). Every method runs
 * in the open unit of the use case, through the Market-scoped client. Nothing is ever deleted.
 */
export interface AttributeRepository {
  /** The id of the definition with this code in this Market, or null. */
  definitionIdByCode(
    market: MarketContext,
    code: string,
  ): Promise<Id<'AttributeDefinition'> | null>;

  /** Which of these codes name an active definition of this Market. */
  activeDefinitionCodes(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /** The id of the family with this code in this Market, or null. */
  familyIdByCode(market: MarketContext, code: string): Promise<Id<'AttributeFamily'> | null>;

  /**
   * The attribute schema of the family with this code, built from the family's published
   * revision and the published revision of each definition it names (catalog design 3.3 rule 1),
   * or null when the family is unknown, archived, or names a definition that is missing or
   * archived (a partial schema is never returned).
   */
  loadSchema(market: MarketContext, familyCode: string): Promise<AttributeSchema | null>;

  /**
   * Inserts a definition built by `AttributeDefinition.create`: the root with no revision
   * pointer, revision 1 with its options, then the pointer, so the pointer is never null
   * after commit.
   */
  addDefinition(market: MarketContext, definition: AttributeDefinition): Promise<void>;

  /** Inserts a family and its first revision the same way. */
  addFamily(market: MarketContext, family: AttributeFamily): Promise<void>;
}

export const ATTRIBUTE_REPOSITORY = Symbol('ATTRIBUTE_REPOSITORY');
