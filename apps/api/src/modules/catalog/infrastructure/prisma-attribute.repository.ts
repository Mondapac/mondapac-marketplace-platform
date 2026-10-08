import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { AttributeRepository } from '../application/ports/attribute.repository';
import type { AttributeDefinition } from '../domain/attribute-definition';
import type { AttributeFamily } from '../domain/attribute-family';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/**
 * {@link AttributeRepository} on `catalog.attribute_definitions`, their revisions and options,
 * `attribute_families` and their revisions. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`; no row is ever deleted
 * and the revisions are insert-only.
 */
export class PrismaAttributeRepository implements AttributeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async definitionIdByCode(
    market: MarketContext,
    code: string,
  ): Promise<Id<'AttributeDefinition'> | null> {
    const row = await this.prisma.tx(market).catalogAttributeDefinition.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row === null ? null : (row.id as Id<'AttributeDefinition'>);
  }

  async activeDefinitionCodes(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (codes.length === 0) return new Set();
    const rows = await this.prisma.tx(market).catalogAttributeDefinition.findMany({
      where: { marketId: market.marketId, code: { in: [...codes] }, status: 'active' },
      select: { code: true },
    });
    return new Set(rows.map((row) => row.code));
  }

  async familyIdByCode(market: MarketContext, code: string): Promise<Id<'AttributeFamily'> | null> {
    const row = await this.prisma.tx(market).catalogAttributeFamily.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row === null ? null : (row.id as Id<'AttributeFamily'>);
  }

  async addDefinition(market: MarketContext, definition: AttributeDefinition): Promise<void> {
    const state = definition.state;
    if (state.marketId !== market.marketId) {
      throw new Error('addDefinition: the definition is of another Market');
    }
    const tx = this.prisma.tx(market);
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
        createdByKind: state.createdByKind,
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
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
        authorKind: state.createdByKind,
        authorAccountId: null,
        relaxationRequestId: null,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
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
        })),
      });
    }
    const { count } = await tx.catalogAttributeDefinition.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version },
      data: { publishedRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-definition', state.id);
  }

  async addFamily(market: MarketContext, family: AttributeFamily): Promise<void> {
    const state = family.state;
    if (state.marketId !== market.marketId) {
      throw new Error('addFamily: the family is of another Market');
    }
    const tx = this.prisma.tx(market);
    await tx.catalogAttributeFamily.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        code: state.code,
        status: state.status,
        publishedRevisionId: null,
        createdByKind: state.createdByKind,
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    await tx.catalogAttributeFamilyRevision.create({
      data: {
        id: state.revisionId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        familyId: state.id,
        revisionNo: state.revisionNo,
        groups: state.groups.map((group) => ({
          groupCode: group.groupCode,
          attributes: group.attributes.map((entry) => ({ ...entry })),
        })),
        authorKind: state.createdByKind,
        authorAccountId: null,
        relaxationRequestId: null,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    const { count } = await tx.catalogAttributeFamily.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version },
      data: { publishedRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-family', state.id);
  }
}
