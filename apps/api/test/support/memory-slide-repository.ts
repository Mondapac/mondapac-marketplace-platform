import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  PlacementRow,
  SlideChange,
  SlideRecord,
  SlideRepository,
  SlideStamp,
  SlideVersionRecord,
} from '../../src/modules/storefront/application/ports/slide.repository';
import type { SlideScope } from '../../src/modules/storefront/domain/slide-positions';

/**
 * The slide tables in memory, for use-case tests: every row carries its Market and every method
 * reads only the caller's Market, like the Prisma repository. Versions are insert-only.
 */
export class MemorySlides implements SlideRepository {
  readonly slides = new Map<string, SlideRecord & { marketId: string }>();
  readonly versionRows = new Map<string, SlideVersionRecord & { marketId: string }>();
  readonly placements: (PlacementRow & { marketId: string })[] = [];
  readonly locks: string[] = [];

  listSlides(m: MarketContext, limit: number) {
    return Promise.resolve(
      [...this.slides.values()]
        .filter((s) => s.marketId === m.marketId)
        .reverse()
        .slice(0, limit),
    );
  }
  findSlide(m: MarketContext, id: Id<'StorefrontSlide'>) {
    const slide = this.slides.get(id);
    return Promise.resolve(slide !== undefined && slide.marketId === m.marketId ? slide : null);
  }
  lockSlide(m: MarketContext, id: Id<'StorefrontSlide'>) {
    this.locks.push(id);
    return this.findSlide(m, id);
  }
  insertSlide(m: MarketContext, slide: SlideRecord) {
    this.slides.set(slide.id, { ...slide, marketId: m.marketId });
    return Promise.resolve();
  }
  updateSlide(m: MarketContext, id: Id<'StorefrontSlide'>, change: SlideChange, stamp: SlideStamp) {
    const slide = this.slides.get(id);
    if (slide === undefined || slide.marketId !== m.marketId) return Promise.resolve();
    this.slides.set(id, { ...slide, ...change, updatedAt: stamp.at });
    return Promise.resolve();
  }
  versionsByIds(m: MarketContext, ids: readonly Id<'StorefrontSlideVersion'>[]) {
    return Promise.resolve(
      ids
        .map((id) => this.versionRows.get(id))
        .filter((v): v is SlideVersionRecord & { marketId: string } => v?.marketId === m.marketId),
    );
  }
  versions(m: MarketContext, slideId: Id<'StorefrontSlide'>, limit: number) {
    return Promise.resolve(
      [...this.versionRows.values()]
        .filter((v) => v.marketId === m.marketId && v.slideId === slideId)
        .sort((a, b) => b.versionNo - a.versionNo)
        .slice(0, limit),
    );
  }
  findVersion(m: MarketContext, slideId: Id<'StorefrontSlide'>, id: Id<'StorefrontSlideVersion'>) {
    const row = this.versionRows.get(id);
    return Promise.resolve(
      row !== undefined && row.marketId === m.marketId && row.slideId === slideId ? row : null,
    );
  }
  async lastVersionNo(m: MarketContext, slideId: Id<'StorefrontSlide'>) {
    return Math.max(0, ...(await this.versions(m, slideId, 1000)).map((v) => v.versionNo));
  }
  insertVersion(m: MarketContext, version: Omit<SlideVersionRecord, 'approvedBy' | 'approvedAt'>) {
    if (this.versionRows.has(version.id)) throw new Error('versions are insert-only');
    this.versionRows.set(version.id, {
      ...version,
      approvedBy: null,
      approvedAt: null,
      marketId: m.marketId,
    });
    return Promise.resolve();
  }
  markApproved(m: MarketContext, id: Id<'StorefrontSlideVersion'>, stamp: SlideStamp) {
    const row = this.versionRows.get(id);
    if (row !== undefined && row.marketId === m.marketId && row.approvedBy === null) {
      this.versionRows.set(id, { ...row, approvedBy: stamp.by, approvedAt: stamp.at });
    }
    return Promise.resolve();
  }
  lockPositions(_m: MarketContext, keys: readonly string[]) {
    this.locks.push(...[...new Set(keys)].sort());
    return Promise.resolve();
  }
  placedAt(m: MarketContext, position: string, from: Temporal.Instant, to: Temporal.Instant) {
    return Promise.resolve(
      this.placements
        .filter(
          (p) =>
            p.marketId === m.marketId &&
            p.position === position &&
            p.startsAt.epochMilliseconds < to.epochMilliseconds &&
            p.endsAt.epochMilliseconds > from.epochMilliseconds,
        )
        .map((p) => ({
          slideId: p.slideId,
          scope: p.scope as SlideScope,
          scopeId: p.scopeId,
          includeSubcategories: p.includeSubcategories,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
        })),
    );
  }
  servedAt(m: MarketContext, position: string, after: Temporal.Instant, limit: number) {
    return Promise.resolve(
      this.placements
        .filter(
          (p) =>
            p.marketId === m.marketId &&
            p.position === position &&
            p.endsAt.epochMilliseconds > after.epochMilliseconds,
        )
        .flatMap((p) => {
          const slide = this.slides.get(p.slideId);
          if (
            slide === undefined ||
            slide.marketId !== m.marketId ||
            slide.state !== 'approved' ||
            slide.liveVersionId === null
          ) {
            return [];
          }
          return [
            {
              slideId: p.slideId,
              kind: slide.kind,
              liveVersionId: slide.liveVersionId,
              scope: p.scope as SlideScope,
              scopeId: p.scopeId,
              includeSubcategories: p.includeSubcategories,
              sortOrder: p.sortOrder,
              autoplay: p.autoplay,
              startsAt: p.startsAt,
              endsAt: p.endsAt,
              pinned: slide.pinned,
              sponsored: slide.sponsored,
            },
          ];
        })
        .sort((a, b) => a.startsAt.epochMilliseconds - b.startsAt.epochMilliseconds)
        .slice(0, limit),
    );
  }
  placementsOf(m: MarketContext, slideId: Id<'StorefrontSlide'>) {
    return Promise.resolve(
      this.placements.filter((p) => p.marketId === m.marketId && p.slideId === slideId),
    );
  }
  replacePlacements(
    m: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    rows: readonly PlacementRow[],
  ) {
    for (let i = this.placements.length - 1; i >= 0; i -= 1) {
      const p = this.placements[i]!;
      if (p.marketId === m.marketId && p.slideId === slideId) this.placements.splice(i, 1);
    }
    this.placements.push(...rows.map((r) => ({ ...r, marketId: m.marketId })));
    return Promise.resolve();
  }
}
