import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PlacementRow,
  SlideChange,
  SlideRecord,
  SlideRepository,
  SlideStamp,
  SlideVersionRecord,
} from '../application/ports/slide.repository';
import type { SlideScope } from '../domain/slide-positions';
import type { SlideKind, StoredSlideState } from '../domain/slides';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const toSlide = (row: {
  readonly id: string;
  readonly kind: string;
  readonly internalName: string;
  readonly state: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly liveVersionId: string | null;
  readonly draftVersionId: string | null;
  readonly submittedVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): SlideRecord => ({
  id: row.id as Id<'StorefrontSlide'>,
  kind: row.kind as SlideKind,
  internalName: row.internalName,
  state: row.state as StoredSlideState,
  startsAt: toInstant(row.startsAt),
  endsAt: toInstant(row.endsAt),
  pinned: row.pinned,
  sponsored: row.sponsored,
  liveVersionId: row.liveVersionId as Id<'StorefrontSlideVersion'> | null,
  draftVersionId: row.draftVersionId as Id<'StorefrontSlideVersion'> | null,
  submittedVersionId: row.submittedVersionId as Id<'StorefrontSlideVersion'> | null,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
});

const toVersion = (row: {
  readonly id: string;
  readonly slideId: string;
  readonly versionNo: number;
  readonly internalName: string;
  readonly content: unknown;
  readonly placements: unknown;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}): SlideVersionRecord => ({
  id: row.id as Id<'StorefrontSlideVersion'>,
  slideId: row.slideId as Id<'StorefrontSlide'>,
  versionNo: row.versionNo,
  internalName: row.internalName,
  content: row.content,
  placements: row.placements,
  startsAt: toInstant(row.startsAt),
  endsAt: toInstant(row.endsAt),
  pinned: row.pinned,
  sponsored: row.sponsored,
  createdAt: toInstant(row.createdAt),
  createdBy: row.createdBy as Id<'Account'>,
  approvedBy: row.approvedBy as Id<'Account'> | null,
  approvedAt: row.approvedAt === null ? null : toInstant(row.approvedAt),
});

/** {@link SlideRepository} on the `storefront` schema, scoped by `marketId` in every `where`. */
export class PrismaSlideRepository implements SlideRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listSlides(market: MarketContext, limit: number) {
    const rows = await this.prisma.tx(market).storefrontSlide.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toSlide);
  }

  async findSlide(market: MarketContext, id: Id<'StorefrontSlide'>) {
    const row = await this.prisma.tx(market).storefrontSlide.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : toSlide(row);
  }

  async lockSlide(market: MarketContext, id: Id<'StorefrontSlide'>) {
    // A same-value update takes the row lock until the unit ends (the guarded client sends no raw
    // SQL); the read after it sees what was committed before the lock was granted.
    const first = await this.findSlide(market, id);
    if (first === null) return null;
    await this.prisma.tx(market).storefrontSlide.updateMany({
      where: { marketId: market.marketId, id },
      data: { updatedAt: toDate(first.updatedAt) },
    });
    return this.findSlide(market, id);
  }

  async insertSlide(market: MarketContext, slide: SlideRecord, by: Id<'Account'>) {
    await this.prisma.tx(market).storefrontSlide.create({
      data: {
        id: slide.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        kind: slide.kind,
        internalName: slide.internalName,
        state: slide.state,
        startsAt: toDate(slide.startsAt),
        endsAt: toDate(slide.endsAt),
        pinned: slide.pinned,
        sponsored: slide.sponsored,
        liveVersionId: slide.liveVersionId,
        draftVersionId: slide.draftVersionId,
        submittedVersionId: slide.submittedVersionId,
        createdAt: toDate(slide.createdAt),
        createdBy: by,
        updatedAt: toDate(slide.updatedAt),
        updatedBy: by,
      },
    });
  }

  async updateSlide(
    market: MarketContext,
    id: Id<'StorefrontSlide'>,
    change: SlideChange,
    stamp: SlideStamp,
  ) {
    await this.prisma.tx(market).storefrontSlide.updateMany({
      where: { marketId: market.marketId, id },
      data: {
        ...(change.internalName !== undefined ? { internalName: change.internalName } : {}),
        ...(change.state !== undefined ? { state: change.state } : {}),
        ...(change.startsAt !== undefined ? { startsAt: toDate(change.startsAt) } : {}),
        ...(change.endsAt !== undefined ? { endsAt: toDate(change.endsAt) } : {}),
        ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
        ...(change.sponsored !== undefined ? { sponsored: change.sponsored } : {}),
        ...(change.liveVersionId !== undefined ? { liveVersionId: change.liveVersionId } : {}),
        ...(change.draftVersionId !== undefined ? { draftVersionId: change.draftVersionId } : {}),
        ...(change.submittedVersionId !== undefined
          ? { submittedVersionId: change.submittedVersionId }
          : {}),
        updatedAt: toDate(stamp.at),
        updatedBy: stamp.by,
      },
    });
  }

  async versionsByIds(market: MarketContext, ids: readonly Id<'StorefrontSlideVersion'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).storefrontSlideVersion.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map(toVersion);
  }

  async versions(market: MarketContext, slideId: Id<'StorefrontSlide'>, limit: number) {
    const rows = await this.prisma.tx(market).storefrontSlideVersion.findMany({
      where: { marketId: market.marketId, slideId },
      orderBy: [{ versionNo: 'desc' }],
      take: limit,
    });
    return rows.map(toVersion);
  }

  async findVersion(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    id: Id<'StorefrontSlideVersion'>,
  ) {
    const row = await this.prisma.tx(market).storefrontSlideVersion.findFirst({
      where: { marketId: market.marketId, slideId, id },
    });
    return row === null ? null : toVersion(row);
  }

  async lastVersionNo(market: MarketContext, slideId: Id<'StorefrontSlide'>) {
    const row = await this.prisma.tx(market).storefrontSlideVersion.findFirst({
      where: { marketId: market.marketId, slideId },
      orderBy: [{ versionNo: 'desc' }],
      select: { versionNo: true },
    });
    return row?.versionNo ?? 0;
  }

  async insertVersion(
    market: MarketContext,
    version: Omit<SlideVersionRecord, 'approvedBy' | 'approvedAt'>,
  ) {
    await this.prisma.tx(market).storefrontSlideVersion.create({
      data: {
        id: version.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        slideId: version.slideId,
        versionNo: version.versionNo,
        internalName: version.internalName,
        content: version.content as object,
        placements: version.placements as object,
        startsAt: toDate(version.startsAt),
        endsAt: toDate(version.endsAt),
        pinned: version.pinned,
        sponsored: version.sponsored,
        createdAt: toDate(version.createdAt),
        createdBy: version.createdBy,
      },
    });
  }

  async markApproved(market: MarketContext, id: Id<'StorefrontSlideVersion'>, stamp: SlideStamp) {
    await this.prisma.tx(market).storefrontSlideVersion.updateMany({
      where: { marketId: market.marketId, id, approvedBy: null },
      data: { approvedBy: stamp.by, approvedAt: toDate(stamp.at) },
    });
  }

  async lockPositions(market: MarketContext, keys: readonly string[], at: Temporal.Instant) {
    const tx = this.prisma.tx(market);
    for (const positionKey of [...new Set(keys)].sort()) {
      // ON CONFLICT DO NOTHING, then a same-value update that holds the row until the unit ends.
      await tx.storefrontSlidePositionLock.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            positionKey,
            touchedAt: toDate(at),
          },
        ],
        skipDuplicates: true,
      });
      const row = await tx.storefrontSlidePositionLock.findFirst({
        where: { marketId: market.marketId, positionKey },
      });
      await tx.storefrontSlidePositionLock.updateMany({
        where: { marketId: market.marketId, positionKey },
        data: { touchedAt: row?.touchedAt ?? toDate(at) },
      });
    }
  }

  async placedAt(
    market: MarketContext,
    position: string,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ) {
    const rows = await this.prisma.tx(market).storefrontSlidePlacement.findMany({
      where: {
        marketId: market.marketId,
        positionKey: position,
        startsAt: { lt: toDate(to) },
        endsAt: { gt: toDate(from) },
      },
    });
    return rows.map((row) => ({
      slideId: row.slideId,
      scope: row.scope as SlideScope,
      scopeId: row.scopeId,
      includeSubcategories: row.includeSubcategories,
      startsAt: toInstant(row.startsAt),
      endsAt: toInstant(row.endsAt),
    }));
  }

  async placementsOf(market: MarketContext, slideId: Id<'StorefrontSlide'>) {
    const rows = await this.prisma.tx(market).storefrontSlidePlacement.findMany({
      where: { marketId: market.marketId, slideId },
      orderBy: [{ positionKey: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row): PlacementRow => ({
      id: row.id as Id<'StorefrontSlidePlacement'>,
      slideId: row.slideId as Id<'StorefrontSlide'>,
      position: row.positionKey,
      scope: row.scope,
      scopeId: row.scopeId,
      includeSubcategories: row.includeSubcategories,
      sortOrder: row.sortOrder,
      autoplay: row.autoplay,
      startsAt: toInstant(row.startsAt),
      endsAt: toInstant(row.endsAt),
    }));
  }

  async replacePlacements(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    rows: readonly PlacementRow[],
  ) {
    const tx = this.prisma.tx(market);
    await tx.storefrontSlidePlacement.deleteMany({
      where: { marketId: market.marketId, slideId },
    });
    if (rows.length === 0) return;
    await tx.storefrontSlidePlacement.createMany({
      data: rows.map((row) => ({
        id: row.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        slideId,
        positionKey: row.position,
        scope: row.scope,
        scopeId: row.scopeId,
        includeSubcategories: row.includeSubcategories,
        sortOrder: row.sortOrder,
        autoplay: row.autoplay,
        startsAt: toDate(row.startsAt),
        endsAt: toDate(row.endsAt),
      })),
    });
  }
}
