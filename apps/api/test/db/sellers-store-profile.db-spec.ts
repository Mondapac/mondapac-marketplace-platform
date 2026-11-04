import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { ContentHash, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { SealedStoreProfileContent } from '../../src/modules/sellers/application/ports/store-profile-content.repository';
import { SellerFile } from '../../src/modules/sellers/domain/seller-file';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { PrismaStoreImageRepository } from '../../src/modules/sellers/infrastructure/prisma-store-image.repository';
import { PrismaStoreProfileContentRepository } from '../../src/modules/sellers/infrastructure/prisma-store-profile-content.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The store profile content on PostgreSQL (sellers slice 12 part 2), for both Market fixtures, as
// the application role: a revision is insert-only and moves the published pointer in the same
// unit, a stale writer inserts nothing, the pointer and the images never cross a seller or a
// Market, there is one current image of a kind, and the role has no UPDATE or DELETE on revisions.

const T0 = Temporal.Instant.from('2026-10-15T01:00:00Z');
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(TEST_MARKETS)('store profile content in market %s', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let owner: Client;
  let files: PrismaSellerFileRepository;
  let content: PrismaStoreProfileContentRepository;
  let images: PrismaStoreImageRepository;

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    content = new PrismaStoreProfileContentRepository(db.service);
    images = new PrismaStoreImageRepository(db.service);
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const inUnit = async <T>(work: () => Promise<T>, m: MarketContext = market): Promise<T> => {
    const result = await db.unitOfWork.run(m, async () => ok(await work()));
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };

  async function newSeller(m: MarketContext = market): Promise<Id<'Seller'>> {
    clock.advance(Temporal.Duration.from({ milliseconds: 2 }));
    const sellerId = ids.next<'Seller'>();
    await inUnit(
      () =>
        files.addWithRoots(
          m,
          SellerFile.create({
            sellerId,
            marketId: m.marketId,
            origin: 'self',
            approvalRequiredAtRegistration: true,
            now: T0,
          }),
        ),
      m,
    );
    return sellerId;
  }

  let hashCounter = 0;
  const revision = (expectedRevisionNo: number) => {
    hashCounter += 1;
    return {
      id: ids.next<'StoreProfileRevision'>(),
      expectedRevisionNo,
      ciphertext: `v1.${'B'.repeat(80)}` as SealedStoreProfileContent,
      schemaVersion: 1,
      contentHash: `hmac-sha256:${hashCounter.toString().padStart(64, '0')}` as ContentHash,
      authorAccountId: ACCOUNT,
      createdAt: T0,
    };
  };

  const newImage = (sellerId: Id<'Seller'>, kind: 'logo' | 'banner') => {
    const id = ids.next<'StoreImage'>();
    const key = (size: string) => `${sellerId}/store-images/${id}/${size}.jpg`;
    return {
      id,
      kind,
      uploaderAccountId: ACCOUNT,
      width: 512,
      height: kind === 'logo' ? 512 : 384,
      uploadedBytes: 1000,
      createdAt: T0,
      renditions: (['large', 'small'] as const).map((size) => ({
        size,
        objectKey: key(size),
        sha256: Buffer.alloc(32, 7),
        byteSize: 500,
        width: size === 'large' ? 512 : 128,
        height: size === 'large' ? (kind === 'logo' ? 512 : 384) : kind === 'logo' ? 128 : 96,
      })),
    };
  };

  describe('revisions', () => {
    it('has nothing published before the first save', async () => {
      const sellerId = await newSeller();

      expect(await inUnit(() => content.published(market, sellerId))).toBeNull();
    });

    it('inserts a revision and moves the pointer in one unit, numbering from 1', async () => {
      const sellerId = await newSeller();
      const first = revision(0);

      expect(await inUnit(() => content.publish(market, sellerId, first))).toBe('published');
      const published = await inUnit(() => content.published(market, sellerId));

      expect(published).toEqual({
        revisionId: first.id,
        revisionNo: 1,
        contentHash: first.contentHash,
      });
      expect(await inUnit(() => content.content(market, sellerId, first.id))).toBe(
        first.ciphertext,
      );

      const second = revision(1);
      expect(await inUnit(() => content.publish(market, sellerId, second))).toBe('published');
      expect((await inUnit(() => content.published(market, sellerId)))?.revisionNo).toBe(2);
    });

    it('refuses a stale writer without inserting anything', async () => {
      const sellerId = await newSeller();
      expect(await inUnit(() => content.publish(market, sellerId, revision(0)))).toBe('published');
      const late = revision(0);

      expect(await inUnit(() => content.publish(market, sellerId, late))).toBe('stale');

      expect((await inUnit(() => content.published(market, sellerId)))?.revisionNo).toBe(1);
      const count = await owner.query(
        'SELECT count(*)::int AS n FROM sellers.store_profile_revisions WHERE seller_id = $1',
        [sellerId],
      );
      expect((count.rows[0] as { n: number }).n).toBe(1);
    });

    it('answers no-profile for a seller with no store profile row', async () => {
      const stranger = ids.next<'Seller'>();

      expect(await inUnit(() => content.publish(market, stranger, revision(0)))).toBe('no-profile');
    });

    it("never reads another seller's or another Market's revision", async () => {
      const mine = await newSeller();
      const theirs = await newSeller();
      const saved = revision(0);
      await inUnit(() => content.publish(market, mine, saved));

      expect(await inUnit(() => content.content(market, theirs, saved.id))).toBeNull();
      expect(await inUnit(() => content.published(other, mine), other)).toBeNull();
      expect(await inUnit(() => content.content(other, mine, saved.id), other)).toBeNull();
    });

    it('lets the application role insert and read revisions but never change or delete one', async () => {
      const sellerId = await newSeller();
      const saved = revision(0);
      await inUnit(() => content.publish(market, sellerId, saved));
      const app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
      try {
        await expect(
          app.query('UPDATE sellers.store_profile_revisions SET content_schema_version = 2'),
        ).rejects.toThrow(/permission denied/);
        await expect(app.query('DELETE FROM sellers.store_profile_revisions')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await app.end();
      }
    });

    it('refuses a ciphertext that is not a version-1 envelope-sized string and an unknown schema', async () => {
      const sellerId = await newSeller();
      const bad = { ...revision(0), ciphertext: 'x'.repeat(70_000) as SealedStoreProfileContent };

      await expect(inUnit(() => content.publish(market, sellerId, bad))).rejects.toThrow();
    });
  });

  describe('images', () => {
    it('keeps one current image of a kind and finds it by id only while it is current', async () => {
      const sellerId = await newSeller();
      const first = newImage(sellerId, 'logo');

      const none = await inUnit(() => images.replace(market, sellerId, first));
      expect(none).toEqual({ replacedId: null, objectKeys: [] });
      const second = newImage(sellerId, 'logo');
      const replaced = await inUnit(() => images.replace(market, sellerId, second));

      expect(replaced.replacedId).toBe(first.id);
      expect([...replaced.objectKeys].sort()).toEqual(
        first.renditions.map((r) => r.objectKey).sort(),
      );
      expect(await inUnit(() => images.findCurrent(market, sellerId, first.id))).toBeNull();
      const found = await inUnit(() => images.findCurrent(market, sellerId, second.id));
      expect(found).toMatchObject({ id: second.id, kind: 'logo', width: 512, height: 512 });
      expect(found?.renditions.map((r) => r.size).sort()).toEqual(['large', 'small']);
    });

    it('keeps a logo and a banner side by side', async () => {
      const sellerId = await newSeller();
      await inUnit(() => images.replace(market, sellerId, newImage(sellerId, 'logo')));
      await inUnit(() => images.replace(market, sellerId, newImage(sellerId, 'banner')));

      const current = await inUnit(() => images.currentOf(market, sellerId));

      expect(current.map((image) => image.kind).sort()).toEqual(['banner', 'logo']);
    });

    it('names for the file sweep only keys of a seller of this Market that no rendition holds', async () => {
      const sellerId = await newSeller();
      const strangerSeller = await newSeller(other);
      const logo = newImage(sellerId, 'logo');
      await inUnit(() => images.replace(market, sellerId, logo));
      const held = logo.renditions.map((rendition) => rendition.objectKey);
      const stray = `${sellerId}/store-images/${ids.next<'StoreImage'>()}/large`;
      const ofOtherMarket = `${strangerSeller}/store-images/${ids.next<'StoreImage'>()}/large`;
      const ofNobody = `${ids.next<'Seller'>()}/store-images/${ids.next<'StoreImage'>()}/large`;

      const found = await inUnit(() =>
        images.unreferencedObjectKeys(market, [...held, stray, ofOtherMarket, ofNobody]),
      );

      expect(found).toEqual([stray]);
      expect(await inUnit(() => images.unreferencedObjectKeys(market, []))).toEqual([]);
    });

    it('removes the current image and answers its objects; removing nothing answers null', async () => {
      const sellerId = await newSeller();
      const logo = newImage(sellerId, 'logo');
      await inUnit(() => images.replace(market, sellerId, logo));

      const removed = await inUnit(() => images.remove(market, sellerId, 'logo'));

      expect(removed?.imageId).toBe(logo.id);
      expect(removed?.objectKeys).toHaveLength(2);
      expect(await inUnit(() => images.findCurrent(market, sellerId, logo.id))).toBeNull();
      expect(await inUnit(() => images.remove(market, sellerId, 'logo'))).toBeNull();
    });

    it('lists the logos of many stores in one read, leaving out stores with none', async () => {
      const withLogo = await newSeller();
      const without = await newSeller();
      const logo = newImage(withLogo, 'logo');
      await inUnit(() => images.replace(market, withLogo, logo));
      await inUnit(() => images.replace(market, withLogo, newImage(withLogo, 'banner')));

      const logos = await inUnit(() => images.logosOf(market, [withLogo, without]));

      expect([...logos.keys()]).toEqual([withLogo]);
      expect(logos.get(withLogo)).toEqual({ id: logo.id, width: 512, height: 512 });
    });

    it("never finds another seller's or another Market's image", async () => {
      const mine = await newSeller();
      const theirs = await newSeller();
      const logo = newImage(mine, 'logo');
      await inUnit(() => images.replace(market, mine, logo));

      expect(await inUnit(() => images.findCurrent(market, theirs, logo.id))).toBeNull();
      expect(await inUnit(() => images.findCurrent(other, mine, logo.id), other)).toBeNull();
      expect(await inUnit(() => images.currentOf(other, mine), other)).toEqual([]);
    });

    it("refuses an object key outside the seller's own store-images prefix", async () => {
      const sellerId = await newSeller();
      const stranger = ids.next<'Seller'>();
      const bad = newImage(stranger, 'logo');

      await expect(inUnit(() => images.replace(market, sellerId, bad))).rejects.toThrow();
    });
  });
});
