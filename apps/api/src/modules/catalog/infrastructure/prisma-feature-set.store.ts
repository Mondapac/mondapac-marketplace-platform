import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import {
  FeatureSetCodeTakenError,
  type FeatureSetStore,
} from '../application/ports/feature-set.store';
import type { LocalizedText } from '../domain/attribute-definition';
import {
  AttributeFamily,
  type AttributeFamilyState,
  type FamilyGroup,
} from '../domain/attribute-family';
import type { CategoryAuthorKind } from '../domain/platform-category';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const CODE_KEY = 'attribute_families_market_id_code_key';

/**
 * {@link FeatureSetStore} on `catalog.attribute_families` and their insert-only revisions (catalog
 * data design 3.5; attributes A4). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`. The family row is written only in its granted columns
 * (status, pointer, version), each time behind its version.
 */
export class PrismaFeatureSetStore implements FeatureSetStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(
    market: MarketContext,
    id: Id<'AttributeFamily'>,
  ): Promise<AttributeFamily | null> {
    const row = await this.prisma.tx(market).catalogAttributeFamily.findFirst({
      where: { marketId: market.marketId, id },
      include: { publishedRevision: true },
    });
    const revision = row?.publishedRevision;
    if (row === null || revision === null || revision === undefined) return null;
    if (row.status !== 'active' && row.status !== 'archived') return null;
    const state: AttributeFamilyState = {
      id: row.id as Id<'AttributeFamily'>,
      marketId: row.marketId as MarketId,
      code: row.code,
      status: row.status,
      createdByKind: row.createdByKind as CategoryAuthorKind,
      revisionId: revision.id as Id<'AttributeFamilyRevision'>,
      revisionNo: revision.revisionNo,
      names: (revision.names ?? {}) as LocalizedText,
      groups: (revision.groups ?? []) as unknown as FamilyGroup[],
      version: row.version,
      createdAt: toInstant(row.createdAt),
    };
    return AttributeFamily.rehydrate(state);
  }

  async codeTaken(market: MarketContext, code: string): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogAttributeFamily.findFirst({
      where: { marketId: market.marketId, code },
      select: { id: true },
    });
    return row !== null;
  }

  async addNew(
    market: MarketContext,
    family: AttributeFamily,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = family.state;
    this.#sameMarket(market, state);
    if (state.version !== 1 || state.revisionNo !== 1 || state.createdByKind !== 'admin') {
      throw new Error('addNew: only a new admin feature set is added');
    }
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogAttributeFamily.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          code: state.code,
          status: state.status,
          publishedRevisionId: null,
          createdByKind: 'admin',
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (isCodeViolation(error)) throw new FeatureSetCodeTakenError();
      throw error;
    }
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await tx.catalogAttributeFamily.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version },
      data: { publishedRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-family', state.id);
  }

  async saveRevision(
    market: MarketContext,
    family: AttributeFamily,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = family.state;
    this.#sameMarket(market, state);
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await this.prisma.tx(market).catalogAttributeFamily.updateMany({
      where: { marketId: market.marketId, id: state.id, version: state.version - 1 },
      data: { publishedRevisionId: state.revisionId, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-family', state.id);
  }

  async #insertRevision(
    market: MarketContext,
    state: AttributeFamilyState,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    // A racing save of the same revision number fails on the unique (family, revision_no) key
    // before the version check: both read as a stale write.
    try {
      await this.prisma.tx(market).catalogAttributeFamilyRevision.create({
        data: {
          id: state.revisionId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          familyId: state.id,
          revisionNo: state.revisionNo,
          names: { ...state.names },
          groups: state.groups.map((group) => ({
            groupCode: group.groupCode,
            names: { ...(group.names ?? {}) },
            attributes: group.attributes.map((entry) => ({ ...entry })),
          })),
          authorKind: 'admin',
          authorAccountId,
          relaxationRequestId: null,
          createdAt: toDate(state.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StaleAggregateError('attribute-family', state.id);
      throw error;
    }
  }

  #sameMarket(market: MarketContext, state: AttributeFamilyState): void {
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaFeatureSetStore: the family is of another Market');
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

function isCodeViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const cause = (
    error as {
      meta?: {
        driverAdapterError?: {
          cause?: { constraint?: { index?: unknown }; originalMessage?: unknown };
        };
      };
    }
  ).meta?.driverAdapterError?.cause;
  if (cause?.constraint?.index === CODE_KEY) return true;
  return (
    typeof cause?.originalMessage === 'string' &&
    cause.originalMessage.endsWith(`constraint "${CODE_KEY}"`)
  );
}
