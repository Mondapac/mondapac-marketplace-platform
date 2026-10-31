import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { BrandRepository } from '../application/ports/brand.repository';
import { Brand, sameBrandSpelling, type BrandState, type BrandStatus } from '../domain/brand';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The unique indexes the repository maps to a domain refusal. */
const UNIQUE_SLUG = 'brands_slug_key';

type BrandRow = Prisma.CatalogBrandGetPayload<object>;

/** A stored brand row as the state of the aggregate. */
export function brandStateOf(row: BrandRow): BrandState {
  return {
    id: row.id as Id<'Brand'>,
    slug: row.slug,
    name: row.name,
    nameKey: row.nameKey,
    logoImageId: row.logoImageId,
    logoAlt: row.logoAlt,
    headerImageId: row.headerImageId,
    summary: row.summary,
    originCountry: row.originCountry,
    status: row.status as BrandStatus,
    proposedBySellerId: row.proposedBySellerId as Id<'Seller'> | null,
    approvedBy: row.approvedBy as Id<'Account'> | null,
    mergedIntoId: row.mergedIntoId as Id<'Brand'> | null,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
    version: row.version,
  };
}

/**
 * {@link BrandRepository} on `catalog.brands`, `brand_aliases`, `brand_merge_candidates` and the
 * `brand_id` column of `catalog.products`. The three brand models are exempt from the market scope
 * (they are shared by every Market), so their statements carry no `marketId`; the products
 * statements carry the unit's. Every statement runs through `PrismaService.tx(market)`; writes are
 * single statements, never nested. No brand is ever deleted: the database refuses it.
 */
export class PrismaBrandRepository implements BrandRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: { next<K extends string>(): Id<K> },
  ) {}

  async add(market: MarketContext, brand: Brand): Promise<'brand.slug-taken' | null> {
    const state = brand.state;
    try {
      await this.prisma.tx(market).catalogBrand.create({
        data: {
          id: state.id,
          slug: state.slug,
          name: state.name,
          nameKey: state.nameKey,
          logoImageId: state.logoImageId,
          logoAlt: state.logoAlt,
          headerImageId: state.headerImageId,
          summary: state.summary,
          originCountry: state.originCountry,
          status: state.status,
          proposedBySellerId: state.proposedBySellerId,
          approvedBy: state.approvedBy,
          mergedIntoId: state.mergedIntoId,
          createdAt: toDate(state.createdAt),
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_SLUG) return 'brand.slug-taken';
      throw error;
    }
    return null;
  }

  async findById(market: MarketContext, id: Id<'Brand'>): Promise<Brand | null> {
    const row = await this.prisma.tx(market).catalogBrand.findFirst({ where: { id } });
    return row === null ? null : Brand.restore(brandStateOf(row));
  }

  async findBySlug(market: MarketContext, slug: string): Promise<Brand | null> {
    const row = await this.prisma.tx(market).catalogBrand.findFirst({ where: { slug } });
    return row === null ? null : Brand.restore(brandStateOf(row));
  }

  async save(market: MarketContext, brand: Brand): Promise<'brand.slug-taken' | null> {
    const state = brand.state;
    const expected = brand.persistedVersion;
    if (expected === null) throw new Error('save: the brand was never stored; use add');
    if (!brand.hasChanges) return null;
    try {
      const { count } = await this.prisma.tx(market).catalogBrand.updateMany({
        where: { id: state.id, version: expected },
        data: {
          slug: state.slug,
          name: state.name,
          nameKey: state.nameKey,
          logoImageId: state.logoImageId,
          logoAlt: state.logoAlt,
          headerImageId: state.headerImageId,
          summary: state.summary,
          originCountry: state.originCountry,
          status: state.status,
          approvedBy: state.approvedBy,
          mergedIntoId: state.mergedIntoId,
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
      });
      if (count !== 1) throw new StaleAggregateError('brand', state.id);
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_SLUG) return 'brand.slug-taken';
      throw error;
    }
    return null;
  }

  async slugTaken(market: MarketContext, slug: string): Promise<boolean> {
    const row = await this.prisma
      .tx(market)
      .catalogBrand.findFirst({ where: { slug }, select: { id: true } });
    return row !== null;
  }

  async similarTo(
    market: MarketContext,
    input: { readonly name: string; readonly nameKey: string; readonly limit: number },
  ): Promise<readonly BrandState[]> {
    const rows = await this.prisma.tx(market).catalogBrand.findMany({
      where: {
        status: { not: 'archived' },
        OR: [
          { nameKey: input.nameKey },
          { aliases: { some: { alias: { equals: input.name, mode: 'insensitive' } } } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
    });
    return rows.map(brandStateOf);
  }

  async spellingOwners(
    market: MarketContext,
    spelling: string,
    limit: number,
  ): Promise<readonly BrandState[]> {
    const rows = await this.prisma.tx(market).catalogBrand.findMany({
      where: {
        status: { not: 'archived' },
        OR: [
          { name: { equals: spelling, mode: 'insensitive' } },
          { aliases: { some: { alias: { equals: spelling, mode: 'insensitive' } } } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(brandStateOf);
  }

  async aliasesOf(market: MarketContext, brandId: Id<'Brand'>): Promise<readonly string[]> {
    const rows = await this.prisma.tx(market).catalogBrandAlias.findMany({
      where: { brandId },
      orderBy: [{ alias: 'asc' }],
      select: { alias: true },
    });
    return rows.map((row) => row.alias);
  }

  async openProposalCount(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    return this.prisma
      .tx(market)
      .catalogBrand.count({ where: { proposedBySellerId: sellerId, status: 'draft' } });
  }

  async addAliases(
    market: MarketContext,
    brandId: Id<'Brand'>,
    aliases: readonly string[],
    now: Temporal.Instant,
  ): Promise<readonly string[]> {
    // One statement per spelling, so the answer says which were new: a spelling held already (the
    // unique index on lower(alias)) is skipped without an error.
    const tx = this.prisma.tx(market);
    const added: string[] = [];
    const seen: string[] = [];
    for (const alias of aliases) {
      if (seen.some((other) => sameBrandSpelling(other, alias))) continue;
      seen.push(alias);
      const { count } = await tx.catalogBrandAlias.createMany({
        data: [{ id: this.ids.next<'BrandAlias'>(), brandId, alias, createdAt: toDate(now) }],
        skipDuplicates: true,
      });
      if (count === 1) added.push(alias);
    }
    return added;
  }

  async moveAliases(market: MarketContext, from: Id<'Brand'>, to: Id<'Brand'>): Promise<void> {
    await this.prisma
      .tx(market)
      .catalogBrandAlias.updateMany({ where: { brandId: from }, data: { brandId: to } });
  }

  async moveProducts(market: MarketContext, from: Id<'Brand'>, to: Id<'Brand'>): Promise<number> {
    const { count } = await this.prisma.tx(market).catalogProduct.updateMany({
      where: { marketId: market.marketId, brandId: from },
      data: { brandId: to },
    });
    return count;
  }

  async resolveMerged(
    market: MarketContext,
    input: {
      readonly sources: readonly Id<'Brand'>[];
      readonly target: Id<'Brand'>;
      readonly accountId: Id<'Account'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const outcome = {
      status: 'resolved',
      resolution: 'merged',
      resolvedAt: toDate(input.now),
      resolvedBy: input.accountId,
    };
    await tx.catalogBrandMergeCandidate.updateMany({
      where: { brandId: { in: [...input.sources] }, status: 'open' },
      data: outcome,
    });
    // The target's own row settles when nobody else in its group is left to decide about.
    const own = await tx.catalogBrandMergeCandidate.findFirst({
      where: { brandId: input.target, status: 'open' },
      select: { groupKey: true },
    });
    if (own === null) return;
    const others = await tx.catalogBrandMergeCandidate.count({
      where: { groupKey: own.groupKey, status: 'open', brandId: { not: input.target } },
    });
    if (others === 0) {
      await tx.catalogBrandMergeCandidate.updateMany({
        where: { brandId: input.target, status: 'open' },
        data: outcome,
      });
    }
  }

  async dismissGroup(
    market: MarketContext,
    input: {
      readonly groupKey: string;
      readonly accountId: Id<'Account'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).catalogBrandMergeCandidate.updateMany({
      where: { groupKey: input.groupKey, status: 'open' },
      data: {
        status: 'resolved',
        resolution: 'kept-separate',
        resolvedAt: toDate(input.now),
        resolvedBy: input.accountId,
      },
    });
    return count;
  }
}
