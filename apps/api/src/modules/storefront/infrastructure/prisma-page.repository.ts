import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PageKind,
  PageRecord,
  PageRepository,
  Stamp,
  VersionRecord,
  VersionState,
} from '../application/ports/page.repository';
import { readSeo } from '../domain/page-settings';
import type { LinkedType } from '../domain/templates';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const maybeInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);
const maybeDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);

interface PageRow {
  readonly id: string;
  readonly kind: string;
  readonly systemKey: string | null;
  readonly slug: string | null;
  readonly templateKey: string;
  readonly title: string;
  readonly seo: unknown;
  readonly linkedType: string | null;
  readonly linkedId: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly archivedAt: Date | null;
  readonly archivedRedirect: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const toPage = (row: PageRow): PageRecord => ({
  id: row.id as Id<'StorefrontPage'>,
  kind: row.kind as PageKind,
  systemKey: row.systemKey,
  slug: row.slug,
  templateKey: row.templateKey,
  title: row.title,
  seo: readSeo(row.seo),
  linked:
    row.linkedType === null || row.linkedId === null
      ? null
      : { type: row.linkedType as LinkedType, id: row.linkedId },
  startsAt: maybeInstant(row.startsAt),
  endsAt: maybeInstant(row.endsAt),
  archivedAt: maybeInstant(row.archivedAt),
  archivedRedirect: row.archivedRedirect,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
});

const toVersion = (row: {
  readonly id: string;
  readonly pageId: string;
  readonly versionNo: number;
  readonly state: string;
  readonly placements: unknown;
  readonly settings: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
}): VersionRecord => ({
  id: row.id as Id<'StorefrontPageVersion'>,
  pageId: row.pageId as Id<'StorefrontPage'>,
  versionNo: row.versionNo,
  state: row.state as VersionState,
  placements: row.placements,
  settings: row.settings,
  createdAt: toInstant(row.createdAt),
  updatedAt: toInstant(row.updatedAt),
  publishedAt: maybeInstant(row.publishedAt),
});

const pageData = (market: MarketContext, page: PageRecord, by: Id<'Account'>) => ({
  id: page.id,
  marketId: market.marketId,
  tenantId: market.tenantId,
  kind: page.kind,
  systemKey: page.systemKey,
  slug: page.slug,
  templateKey: page.templateKey,
  title: page.title,
  seo: page.seo as object,
  linkedType: page.linked?.type ?? null,
  linkedId: page.linked?.id ?? null,
  startsAt: maybeDate(page.startsAt),
  endsAt: maybeDate(page.endsAt),
  archivedAt: null,
  archivedRedirect: null,
  createdAt: toDate(page.createdAt),
  updatedAt: toDate(page.updatedAt),
  updatedBy: by,
});

/** {@link PageRepository} on the `storefront` schema, scoped by `marketId` in every `where`. */
export class PrismaPageRepository implements PageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listPages(market: MarketContext, limit: number) {
    const rows = await this.prisma.tx(market).storefrontPage.findMany({
      where: { marketId: market.marketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toPage);
  }

  async summaries(market: MarketContext) {
    const rows = await this.prisma.tx(market).storefrontPageVersion.findMany({
      where: { marketId: market.marketId, state: { in: ['draft', 'published'] } },
      select: { pageId: true, state: true, versionNo: true, publishedAt: true },
    });
    const byPage = new Map<
      string,
      { draftVersionNo: number | null; publishedVersionNo: number | null; publishedAt: Date | null }
    >();
    for (const row of rows) {
      const entry = byPage.get(row.pageId) ?? {
        draftVersionNo: null,
        publishedVersionNo: null,
        publishedAt: null,
      };
      if (row.state === 'draft') entry.draftVersionNo = row.versionNo;
      else {
        entry.publishedVersionNo = row.versionNo;
        entry.publishedAt = row.publishedAt;
      }
      byPage.set(row.pageId, entry);
    }
    return [...byPage.entries()].map(([pageId, entry]) => ({
      pageId: pageId as Id<'StorefrontPage'>,
      draftVersionNo: entry.draftVersionNo,
      publishedVersionNo: entry.publishedVersionNo,
      publishedAt: maybeInstant(entry.publishedAt),
    }));
  }

  async findPage(market: MarketContext, id: Id<'StorefrontPage'>) {
    const row = await this.prisma.tx(market).storefrontPage.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : toPage(row);
  }

  async findSystemPage(market: MarketContext, key: string) {
    const row = await this.prisma.tx(market).storefrontPage.findFirst({
      where: { marketId: market.marketId, kind: 'system', systemKey: key },
    });
    return row === null ? null : toPage(row);
  }

  async findBySlug(market: MarketContext, slug: string) {
    const row = await this.prisma.tx(market).storefrontPage.findFirst({
      where: { marketId: market.marketId, kind: 'dynamic', slug },
    });
    return row === null ? null : toPage(row);
  }

  async lockPage(market: MarketContext, id: Id<'StorefrontPage'>) {
    // A same-value update takes the row lock until the unit ends (the guarded client sends no raw
    // SQL); the read after it sees what was committed before the lock was granted.
    const first = await this.findPage(market, id);
    if (first === null) return null;
    await this.prisma.tx(market).storefrontPage.updateMany({
      where: { marketId: market.marketId, id },
      data: { updatedAt: toDate(first.updatedAt) },
    });
    return this.findPage(market, id);
  }

  async insertPage(market: MarketContext, page: PageRecord, by: Id<'Account'>): Promise<void> {
    await this.prisma.tx(market).storefrontPage.create({ data: pageData(market, page, by) });
  }

  async insertSystemPageIfAbsent(
    market: MarketContext,
    page: PageRecord,
    by: Id<'Account'>,
  ): Promise<boolean> {
    // ON CONFLICT DO NOTHING: a concurrent first edit's row wins without aborting this unit.
    const { count } = await this.prisma.tx(market).storefrontPage.createMany({
      data: [pageData(market, page, by)],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async updatePage(
    market: MarketContext,
    id: Id<'StorefrontPage'>,
    change: Parameters<PageRepository['updatePage']>[2],
    stamp: Stamp,
  ): Promise<void> {
    await this.prisma.tx(market).storefrontPage.updateMany({
      where: { marketId: market.marketId, id },
      data: {
        ...(change.slug !== undefined ? { slug: change.slug } : {}),
        ...(change.title !== undefined ? { title: change.title } : {}),
        ...(change.seo !== undefined ? { seo: change.seo as object } : {}),
        ...(change.linked !== undefined
          ? { linkedType: change.linked?.type ?? null, linkedId: change.linked?.id ?? null }
          : {}),
        ...(change.startsAt !== undefined ? { startsAt: maybeDate(change.startsAt) } : {}),
        ...(change.endsAt !== undefined ? { endsAt: maybeDate(change.endsAt) } : {}),
        ...(change.archivedAt !== undefined ? { archivedAt: maybeDate(change.archivedAt) } : {}),
        ...(change.archivedRedirect !== undefined
          ? { archivedRedirect: change.archivedRedirect }
          : {}),
        updatedAt: toDate(stamp.at),
        updatedBy: stamp.by,
      },
    });
  }

  async versions(market: MarketContext, pageId: Id<'StorefrontPage'>, limit: number) {
    const rows = await this.prisma.tx(market).storefrontPageVersion.findMany({
      where: { marketId: market.marketId, pageId },
      orderBy: [{ versionNo: 'desc' }],
      take: limit,
    });
    return rows.map(toVersion);
  }

  async findVersion(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    id: Id<'StorefrontPageVersion'>,
  ) {
    const row = await this.prisma.tx(market).storefrontPageVersion.findFirst({
      where: { marketId: market.marketId, pageId, id },
    });
    return row === null ? null : toVersion(row);
  }

  async findDraft(market: MarketContext, pageId: Id<'StorefrontPage'>) {
    return this.findInState(market, pageId, 'draft');
  }

  async findPublished(market: MarketContext, pageId: Id<'StorefrontPage'>) {
    return this.findInState(market, pageId, 'published');
  }

  private async findInState(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    state: VersionState,
  ) {
    const row = await this.prisma.tx(market).storefrontPageVersion.findFirst({
      where: { marketId: market.marketId, pageId, state },
    });
    return row === null ? null : toVersion(row);
  }

  async lastVersionNo(market: MarketContext, pageId: Id<'StorefrontPage'>): Promise<number> {
    const row = await this.prisma.tx(market).storefrontPageVersion.findFirst({
      where: { marketId: market.marketId, pageId },
      orderBy: [{ versionNo: 'desc' }],
      select: { versionNo: true },
    });
    return row?.versionNo ?? 0;
  }

  async insertDraft(
    market: MarketContext,
    draft: Parameters<PageRepository['insertDraft']>[1],
    stamp: Stamp,
  ): Promise<void> {
    await this.prisma.tx(market).storefrontPageVersion.create({
      data: {
        id: draft.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        pageId: draft.pageId,
        versionNo: draft.versionNo,
        state: 'draft',
        placements: draft.placements as object,
        createdAt: toDate(stamp.at),
        createdBy: stamp.by,
        updatedAt: toDate(stamp.at),
        updatedBy: stamp.by,
      },
    });
  }

  async updateDraft(
    market: MarketContext,
    id: Id<'StorefrontPageVersion'>,
    placements: Record<string, unknown>,
    stamp: Stamp,
  ): Promise<void> {
    await this.prisma.tx(market).storefrontPageVersion.updateMany({
      where: { marketId: market.marketId, id, state: 'draft' },
      data: { placements: placements as object, updatedAt: toDate(stamp.at), updatedBy: stamp.by },
    });
  }

  async updateDraftSettings(
    market: MarketContext,
    id: Id<'StorefrontPageVersion'>,
    settings: Record<string, unknown>,
    stamp: Stamp,
  ): Promise<void> {
    await this.prisma.tx(market).storefrontPageVersion.updateMany({
      where: { marketId: market.marketId, id, state: 'draft' },
      data: { settings: settings as object, updatedAt: toDate(stamp.at), updatedBy: stamp.by },
    });
  }

  async publishDraft(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    draftId: Id<'StorefrontPageVersion'>,
    stamp: Stamp,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.storefrontPageVersion.updateMany({
      where: { marketId: market.marketId, pageId, state: 'published' },
      data: { state: 'retired', updatedAt: toDate(stamp.at), updatedBy: stamp.by },
    });
    await tx.storefrontPageVersion.updateMany({
      where: { marketId: market.marketId, pageId, id: draftId, state: 'draft' },
      data: {
        state: 'published',
        publishedAt: toDate(stamp.at),
        publishedBy: stamp.by,
        updatedAt: toDate(stamp.at),
        updatedBy: stamp.by,
      },
    });
  }

  async findRedirect(market: MarketContext, slug: string) {
    const row = await this.prisma.tx(market).storefrontRedirect.findFirst({
      where: { marketId: market.marketId, fromSlug: slug },
      select: { pageId: true },
    });
    return row === null ? null : (row.pageId as Id<'StorefrontPage'>);
  }

  async insertRedirect(
    market: MarketContext,
    redirect: Parameters<PageRepository['insertRedirect']>[1],
    at: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).storefrontRedirect.create({
      data: {
        id: redirect.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        fromSlug: redirect.fromSlug,
        pageId: redirect.pageId,
        createdAt: toDate(at),
      },
    });
  }

  async deleteRedirect(market: MarketContext, fromSlug: string): Promise<void> {
    await this.prisma.tx(market).storefrontRedirect.deleteMany({
      where: { marketId: market.marketId, fromSlug },
    });
  }
}
