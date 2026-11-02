import { Temporal } from '@mondapac/shared-kernel';
import type { AttributeDataType, Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import {
  AttributeCodeTakenError,
  type AttributeDefinitionStore,
} from '../application/ports/attribute-definition.store';
import {
  AttributeDefinition,
  type AttributeBounds,
  type AttributeDefinitionState,
  type AttributeDefinitionStatus,
  type LocalizedText,
} from '../domain/attribute-definition';
import type { CategoryAuthorKind } from '../domain/platform-category';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const STATUSES: readonly string[] = ['draft', 'active', 'archived'];

/**
 * {@link AttributeDefinitionStore} on `catalog.attribute_definitions`, their insert-only revisions
 * and revision options (catalog data design 3.5; attributes A2). Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`. The definition row is
 * written only in its granted columns (status, pointer, version), each time behind its version.
 */
export class PrismaAttributeDefinitionStore implements AttributeDefinitionStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
  ): Promise<AttributeDefinition | null> {
    const row = await this.prisma.tx(market).catalogAttributeDefinition.findFirst({
      where: { marketId: market.marketId, id },
      include: { publishedRevision: { include: { options: true } } },
    });
    const revision = row?.publishedRevision;
    if (row === null || revision === null || revision === undefined) return null;
    if (!STATUSES.includes(row.status)) return null;
    const state: AttributeDefinitionState = {
      id: row.id as Id<'AttributeDefinition'>,
      marketId: row.marketId as MarketId,
      code: row.code,
      dataType: row.dataType as AttributeDataType,
      localizable: row.localizable,
      status: row.status as AttributeDefinitionStatus,
      createdByKind: row.createdByKind as CategoryAuthorKind,
      revisionId: revision.id as Id<'AttributeDefinitionRevision'>,
      revisionNo: revision.revisionNo,
      material: revision.material,
      isVariantOption: revision.isVariantOption,
      bounds: revision.bounds as AttributeBounds,
      names: revision.names as LocalizedText,
      options: [...revision.options]
        .sort((a, b) => a.position - b.position || a.optionCode.localeCompare(b.optionCode))
        .map((option) => ({
          code: option.optionCode,
          labels: option.labels as LocalizedText,
          active: option.active,
          position: option.position,
          mergedInto: option.mergedInto,
        })),
      display: {
        helpText: revision.helpText as LocalizedText,
        showOnProductPage: revision.showOnProductPage,
        searchable: revision.searchable,
        canBeFilter: revision.canBeFilter,
        internalNote: revision.internalNote,
        position: revision.position,
      },
      version: row.version,
      createdAt: toInstant(row.createdAt),
      revisedAt: toInstant(revision.createdAt),
    };
    return AttributeDefinition.rehydrate(state);
  }

  async codeTaken(market: MarketContext, code: string): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogAttributeDefinition.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row !== null;
  }

  async addDraft(
    market: MarketContext,
    definition: AttributeDefinition,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = definition.state;
    this.#sameMarket(market, state);
    if (state.status !== 'draft' || state.version !== 1 || state.revisionNo !== 1) {
      throw new Error('addDraft: only a new draft is added');
    }
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogAttributeDefinition.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          code: state.code,
          dataType: state.dataType,
          localizable: state.localizable,
          status: state.status,
          publishedRevisionId: null,
          createdByKind: 'admin',
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AttributeCodeTakenError();
      throw error;
    }
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await tx.catalogAttributeDefinition.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version },
      data: { publishedRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-definition', state.id);
  }

  async saveRevision(
    market: MarketContext,
    definition: AttributeDefinition,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = definition.state;
    this.#sameMarket(market, state);
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await this.prisma.tx(market).catalogAttributeDefinition.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version - 1 },
      data: { publishedRevisionId: state.revisionId, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-definition', state.id);
  }

  async saveStatus(market: MarketContext, definition: AttributeDefinition): Promise<void> {
    const state = definition.state;
    this.#sameMarket(market, state);
    const { count } = await this.prisma.tx(market).catalogAttributeDefinition.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version - 1 },
      data: { status: state.status, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-definition', state.id);
  }

  async #insertRevision(
    market: MarketContext,
    state: AttributeDefinitionState,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    // A racing save of the same revision number fails on the unique (definition, revision_no)
    // key before the version check: both read as a stale write.
    try {
      await tx.catalogAttributeDefinitionRevision.create({
        data: {
          id: state.revisionId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          definitionId: state.id,
          revisionNo: state.revisionNo,
          material: state.material,
          isVariantOption: state.isVariantOption,
          bounds: { ...state.bounds },
          names: { ...state.names },
          helpText: { ...state.display.helpText },
          showOnProductPage: state.display.showOnProductPage,
          searchable: state.display.searchable,
          canBeFilter: state.display.canBeFilter,
          internalNote: state.display.internalNote,
          position: state.display.position,
          authorKind: 'admin',
          authorAccountId,
          relaxationRequestId: null,
          createdAt: toDate(state.revisedAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StaleAggregateError('attribute-definition', state.id);
      throw error;
    }
    if (state.options.length > 0) {
      await tx.catalogAttributeDefinitionRevisionOption.createMany({
        data: state.options.map((option) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          revisionId: state.revisionId,
          optionCode: option.code,
          labels: { ...option.labels },
          active: option.active,
          position: option.position,
          mergedInto: option.mergedInto ?? null,
        })),
      });
    }
  }

  #sameMarket(market: MarketContext, state: AttributeDefinitionState): void {
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaAttributeDefinitionStore: the definition is of another Market');
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
