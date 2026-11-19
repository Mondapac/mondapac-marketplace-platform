import { createHash } from 'node:crypto';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type {
  BlogImageProcessor,
  MediaRefusalCode,
  ProcessedMediaRendition,
} from '../../src/modules/blog/application/ports/blog-image-processor';
import type {
  BlogMediaStore,
  MediaId,
  MediaRecord,
  NewMedia,
  StoredMediaRendition,
} from '../../src/modules/blog/application/ports/blog-media.store';
import { mediaObjectKey, type MediaSize } from '../../src/modules/blog/domain/media';

/** An in-memory blog media library for specs, kept per Market like the real tables. */
export class MemoryBlogMediaStore implements BlogMediaStore {
  readonly media = new Map<string, NewMedia>();
  /** Every call rejects, as a database that cannot be reached. */
  down = false;

  private key(market: MarketContext, id: string): string {
    return `${market.marketId}:${id}`;
  }

  private reachable(): Promise<void> {
    return this.down ? Promise.reject(new Error('media store down')) : Promise.resolve();
  }

  /** A picture of the Market with no files, as if uploaded before the test. */
  seed(
    market: MarketContext,
    id: string,
    createdAt = Temporal.Instant.from('2026-10-01T00:00:00Z'),
  ) {
    this.media.set(this.key(market, id), {
      id: id as MediaId,
      uploaderAccountId: id as Id<'Account'>,
      width: 1600,
      height: 900,
      uploadedBytes: 1,
      createdAt,
      renditions: (['large', 'thumb'] as const).map((size) => ({
        size,
        objectKey: mediaObjectKey(id, size),
        sha256: createHash('sha256').update(`${id}/${size}`).digest(),
        byteSize: 1,
        width: 1,
        height: 1,
      })),
    });
  }

  async insert(market: MarketContext, media: NewMedia): Promise<void> {
    await this.reachable();
    this.media.set(this.key(market, media.id), media);
  }

  async existing(market: MarketContext, ids: readonly string[]): Promise<ReadonlySet<string>> {
    await this.reachable();
    return new Set(ids.filter((id) => this.media.has(this.key(market, id))));
  }

  async list(
    market: MarketContext,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly MediaRecord[]> {
    await this.reachable();
    const prefix = `${market.marketId}:`;
    return [...this.media.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, media]) => media)
      .sort(
        (a, b) =>
          Temporal.Instant.compare(b.createdAt, a.createdAt) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(page.offset, page.offset + page.limit)
      .map((media) => ({
        id: media.id,
        uploaderAccountId: media.uploaderAccountId,
        width: media.width,
        height: media.height,
        createdAt: media.createdAt,
      }));
  }

  async rendition(
    market: MarketContext,
    mediaId: MediaId,
    size: MediaSize,
  ): Promise<StoredMediaRendition | null> {
    await this.reachable();
    const media = this.media.get(this.key(market, mediaId));
    return media?.renditions.find((rendition) => rendition.size === size) ?? null;
  }
}

/**
 * A picture processor for specs: no decoding. It answers `refusal` when set; otherwise a `large`
 * and a `thumb` rendition whose bytes say which upload they came from.
 */
export class FakeBlogImageProcessor implements BlogImageProcessor {
  refusal: MediaRefusalCode | null = null;
  readonly seen: Buffer[] = [];

  process(
    bytes: Buffer,
  ): Promise<Result<readonly ProcessedMediaRendition[], { readonly code: MediaRefusalCode }>> {
    this.seen.push(bytes);
    if (this.refusal !== null) return Promise.resolve(err({ code: this.refusal }));
    const tag = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return Promise.resolve(
      ok([
        { size: 'large', bytes: Buffer.from(`large:${tag}`), width: 1600, height: 1067 },
        { size: 'thumb', bytes: Buffer.from(`thumb:${tag}`), width: 400, height: 267 },
      ]),
    );
  }
}
