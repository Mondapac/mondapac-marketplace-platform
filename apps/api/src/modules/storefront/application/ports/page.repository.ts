import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Linked, Seo } from '../../domain/page-settings';

export type PageKind = 'system' | 'dynamic';
export type VersionState = 'draft' | 'published' | 'retired';

export interface PageRecord {
  readonly id: Id<'StorefrontPage'>;
  readonly kind: PageKind;
  readonly systemKey: string | null;
  readonly slug: string | null;
  readonly templateKey: string;
  readonly title: string;
  readonly seo: Seo;
  readonly linked: Linked | null;
  readonly startsAt: Temporal.Instant | null;
  readonly endsAt: Temporal.Instant | null;
  readonly archivedAt: Temporal.Instant | null;
  readonly archivedRedirect: string | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface VersionRecord {
  readonly id: Id<'StorefrontPageVersion'>;
  readonly pageId: Id<'StorefrontPage'>;
  readonly versionNo: number;
  readonly state: VersionState;
  /** The stored JSON; read back only through `readPlacements`. */
  readonly placements: unknown;
  /**
   * A draft's page settings (the stored JSON, read back only through `parseStoredSettings`), put
   * on the page row when it is published; null: the draft leaves them as they are.
   */
  readonly settings: unknown;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly publishedAt: Temporal.Instant | null;
}

export interface Stamp {
  readonly at: Temporal.Instant;
  readonly by: Id<'Account'>;
}

/** The live versions of a page, for the admin list. */
export interface VersionSummary {
  readonly pageId: Id<'StorefrontPage'>;
  readonly draftVersionNo: number | null;
  readonly publishedVersionNo: number | null;
  readonly publishedAt: Temporal.Instant | null;
}

/**
 * The storefront pages of one Market (`storefront.pages`, `page_versions`, `redirects`). Every
 * method runs inside the caller's unit of work and is scoped by the Market.
 */
export interface PageRepository {
  /** Every page row of the Market, newest first (system rows included), at most `limit`. */
  listPages(market: MarketContext, limit: number): Promise<readonly PageRecord[]>;
  summaries(market: MarketContext): Promise<readonly VersionSummary[]>;
  findPage(market: MarketContext, id: Id<'StorefrontPage'>): Promise<PageRecord | null>;
  findSystemPage(market: MarketContext, key: string): Promise<PageRecord | null>;
  findBySlug(market: MarketContext, slug: string): Promise<PageRecord | null>;

  /**
   * Like `findPage`, and takes the page row's write lock for the rest of the unit: every change
   * of a page or its versions locks the page first, so two edits of one draft serialise.
   */
  lockPage(market: MarketContext, id: Id<'StorefrontPage'>): Promise<PageRecord | null>;

  insertPage(market: MarketContext, page: PageRecord, by: Id<'Account'>): Promise<void>;
  /**
   * Inserts a system page's row unless the Market already has one for its key (a concurrent
   * first edit); true when this call inserted it.
   */
  insertSystemPageIfAbsent(
    market: MarketContext,
    page: PageRecord,
    by: Id<'Account'>,
  ): Promise<boolean>;
  updatePage(
    market: MarketContext,
    id: Id<'StorefrontPage'>,
    change: Partial<
      Pick<
        PageRecord,
        | 'slug'
        | 'title'
        | 'seo'
        | 'linked'
        | 'startsAt'
        | 'endsAt'
        | 'archivedAt'
        | 'archivedRedirect'
      >
    >,
    stamp: Stamp,
  ): Promise<void>;

  /** Newest first, at most `limit`. */
  versions(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    limit: number,
  ): Promise<readonly VersionRecord[]>;
  findVersion(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    id: Id<'StorefrontPageVersion'>,
  ): Promise<VersionRecord | null>;
  findDraft(market: MarketContext, pageId: Id<'StorefrontPage'>): Promise<VersionRecord | null>;
  findPublished(market: MarketContext, pageId: Id<'StorefrontPage'>): Promise<VersionRecord | null>;
  lastVersionNo(market: MarketContext, pageId: Id<'StorefrontPage'>): Promise<number>;
  insertDraft(
    market: MarketContext,
    draft: {
      readonly id: Id<'StorefrontPageVersion'>;
      readonly pageId: Id<'StorefrontPage'>;
      readonly versionNo: number;
      readonly placements: Record<string, unknown>;
    },
    stamp: Stamp,
  ): Promise<void>;
  updateDraft(
    market: MarketContext,
    id: Id<'StorefrontPageVersion'>,
    placements: Record<string, unknown>,
    stamp: Stamp,
  ): Promise<void>;
  updateDraftSettings(
    market: MarketContext,
    id: Id<'StorefrontPageVersion'>,
    settings: Record<string, unknown>,
    stamp: Stamp,
  ): Promise<void>;
  /** Retires the published version (if any) and publishes the draft `draftId`. */
  publishDraft(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    draftId: Id<'StorefrontPageVersion'>,
    stamp: Stamp,
  ): Promise<void>;

  /** The page an old slug sends buyers to, or null. */
  findRedirect(market: MarketContext, slug: string): Promise<Id<'StorefrontPage'> | null>;
  insertRedirect(
    market: MarketContext,
    redirect: {
      readonly id: Id<'StorefrontRedirect'>;
      readonly fromSlug: string;
      readonly pageId: Id<'StorefrontPage'>;
    },
    at: Temporal.Instant,
  ): Promise<void>;
  deleteRedirect(market: MarketContext, fromSlug: string): Promise<void>;
}

export const PAGE_REPOSITORY = Symbol('STOREFRONT_PAGE_REPOSITORY');
