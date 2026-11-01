import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, ContentHash, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { ObjectListPage, ObjectStore } from '../../../../platform/storage/object-store';
import type { StoreImageKind } from '../../domain/store-image';
import {
  canonicalStoreContent,
  parseStoreContent,
  type StoreProfileContent,
} from '../../domain/store-profile-content';
import type { StoreImageRepository, StoredStoreImage } from '../ports/store-image.repository';
import type {
  StoreProfileContentSealer,
  SealedStoreContent,
} from '../ports/store-profile-content-sealer';
import type {
  NewStoreProfileRevision,
  PublishedRevisionRef,
  SealedStoreProfileContent,
  StoreProfileContentRepository,
} from '../ports/store-profile-content.repository';
import type { ClaimCheckUnavailable, StoreTextClaimCheck } from '../ports/store-text-claim-check';

const keyOf = (market: MarketContext, sellerId: Id<'Seller'>): string =>
  `${market.marketId}|${sellerId}`;

/** Revisions and the published pointer in memory, with the same stale rule as PostgreSQL. */
export class InMemoryStoreContent implements StoreProfileContentRepository {
  readonly revisions = new Map<
    string,
    { sellerKey: string; no: number; ciphertext: SealedStoreProfileContent; hash: ContentHash }
  >();
  readonly pointers = new Map<string, { revisionId: Id<'StoreProfileRevision'>; no: number }>();
  /** Sellers that have a store profile row. */
  readonly profiles = new Set<string>();
  reads = 0;

  addProfile(market: MarketContext, sellerId: Id<'Seller'>): void {
    this.profiles.add(keyOf(market, sellerId));
  }

  published(market: MarketContext, sellerId: Id<'Seller'>): Promise<PublishedRevisionRef | null> {
    const pointer = this.pointers.get(keyOf(market, sellerId));
    if (pointer === undefined) return Promise.resolve(null);
    const revision = this.revisions.get(pointer.revisionId)!;
    return Promise.resolve({
      revisionId: pointer.revisionId,
      revisionNo: pointer.no,
      contentHash: revision.hash,
    });
  }

  content(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'StoreProfileRevision'>,
  ): Promise<SealedStoreProfileContent | null> {
    this.reads += 1;
    const revision = this.revisions.get(revisionId);
    return Promise.resolve(
      revision?.sellerKey === keyOf(market, sellerId) ? revision.ciphertext : null,
    );
  }

  publish(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revision: NewStoreProfileRevision,
  ): Promise<'published' | 'stale' | 'no-profile'> {
    const key = keyOf(market, sellerId);
    if (!this.profiles.has(key)) return Promise.resolve('no-profile');
    const current = this.pointers.get(key)?.no ?? 0;
    if (current !== revision.expectedRevisionNo) return Promise.resolve('stale');
    this.revisions.set(revision.id, {
      sellerKey: key,
      no: current + 1,
      ciphertext: revision.ciphertext,
      hash: revision.contentHash,
    });
    this.pointers.set(key, { revisionId: revision.id, no: current + 1 });
    return Promise.resolve('published');
  }
}

/** The current logo and banner in memory: at most one per seller and kind. */
export class InMemoryStoreImages implements StoreImageRepository {
  readonly current = new Map<string, StoredStoreImage>();

  private at(market: MarketContext, sellerId: Id<'Seller'>, kind: StoreImageKind): string {
    return `${keyOf(market, sellerId)}|${kind}`;
  }

  currentOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly StoredStoreImage[]> {
    return Promise.resolve(
      (['logo', 'banner'] as const).flatMap((kind) => {
        const found = this.current.get(this.at(market, sellerId, kind));
        return found === undefined ? [] : [found];
      }),
    );
  }

  logosOf(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, { id: Id<'StoreImage'>; width: number; height: number }>> {
    const found = new Map<Id<'Seller'>, { id: Id<'StoreImage'>; width: number; height: number }>();
    for (const sellerId of sellerIds) {
      const logo = this.current.get(this.at(market, sellerId, 'logo'));
      if (logo !== undefined)
        found.set(sellerId, { id: logo.id, width: logo.width, height: logo.height });
    }
    return Promise.resolve(found);
  }

  findCurrent(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    imageId: Id<'StoreImage'>,
  ): Promise<StoredStoreImage | null> {
    return this.currentOf(market, sellerId).then(
      (all) => all.find((image) => image.id === imageId) ?? null,
    );
  }

  replace(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    image: Parameters<StoreImageRepository['replace']>[2],
  ) {
    const key = this.at(market, sellerId, image.kind);
    const old = this.current.get(key);
    this.current.set(key, {
      id: image.id,
      kind: image.kind,
      width: image.width,
      height: image.height,
      renditions: image.renditions,
    });
    return Promise.resolve({
      replacedId: old?.id ?? null,
      objectKeys: old?.renditions.map((r) => r.objectKey) ?? [],
    });
  }

  remove(market: MarketContext, sellerId: Id<'Seller'>, kind: StoreImageKind) {
    const key = this.at(market, sellerId, kind);
    const old = this.current.get(key);
    this.current.delete(key);
    return Promise.resolve(
      old === undefined
        ? null
        : { imageId: old.id, objectKeys: old.renditions.map((r) => r.objectKey) },
    );
  }
}

/** A sealer that is not encryption, only opaque enough to prove the text is not stored as is. */
export class FakeContentSealer implements StoreProfileContentSealer {
  readonly destroyed = new Set<string>();
  opens = 0;

  seal(
    _market: MarketContext,
    _sellerId: Id<'Seller'>,
    content: StoreProfileContent,
  ): Promise<Result<SealedStoreContent, never>> {
    const canonical = canonicalStoreContent(content);
    if (!canonical.ok) throw new Error('unexpected content');
    return Promise.resolve(
      ok({
        ciphertext:
          `sealed.${Buffer.from(canonical.value).toString('base64')}` as SealedStoreProfileContent,
        contentHash:
          `hmac-sha256:${createHash('sha256').update(canonical.value).digest('hex')}` as ContentHash,
      }),
    );
  }

  open(market: MarketContext, sellerId: Id<'Seller'>, sealed: SealedStoreProfileContent) {
    this.opens += 1;
    if (this.destroyed.has(keyOf(market, sellerId))) {
      return Promise.resolve(err({ code: 'subject-key.destroyed' } as const));
    }
    return Promise.resolve(
      parseStoreContent(Buffer.from(sealed.slice('sealed.'.length), 'base64').toString('utf8')),
    );
  }
}

/** Flags a text that contains one of the given words; or is unavailable. */
export class FakeClaimCheck implements StoreTextClaimCheck {
  words: readonly string[] = ['claim word'];
  unavailable = false;
  calls = 0;

  flagged(
    _context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], ClaimCheckUnavailable>> {
    this.calls += 1;
    if (this.unavailable) return Promise.resolve(err({ code: 'claim-text.check-unavailable' }));
    return Promise.resolve(
      ok(texts.map(({ text }) => this.words.some((word) => text.toLowerCase().includes(word)))),
    );
  }
}

/** An object store in a map. */
export class MapObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  failPuts = false;
  failAfterPuts: number | null = null;
  private puts = 0;

  put(key: string, bytes: Buffer): Promise<void> {
    this.puts += 1;
    if (this.failPuts || (this.failAfterPuts !== null && this.puts > this.failAfterPuts)) {
      return Promise.reject(new Error('object store down'));
    }
    this.objects.set(key, bytes);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  list(): Promise<ObjectListPage> {
    return Promise.reject(new Error('MapObjectStore does not list'));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
