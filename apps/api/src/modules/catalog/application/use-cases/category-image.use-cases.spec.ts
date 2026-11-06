import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryTreeVersion } from '../../../../../test/support/catalog-category-editor-fakes';
import { MemoryCategoryImages } from '../../../../../test/support/catalog-category-image-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { MemoryObjectStore } from '../../../../platform/storage/disk-object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_CATEGORY_TREE_EDIT,
  CATALOG_CATEGORY_TREE_VIEW,
} from '../../contracts/permissions';
import type { CategoryImageWriteDependencies } from '../categories/category-image';
import type { ImageProcessor, ImageRefusalCode } from '../ports/image-processor';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import { CategoryImageRead } from './category-image-read.use-case';
import { CategoryImageRemove } from './category-image-remove.use-case';
import { CategoryImageSet } from './category-image-set.use-case';

// The category image use cases in memory (categories package C3c), on both Market fixtures: the
// key, the admin population and the acting-as refusal; the closed input; the category version
// guard; the picture refusals of the pipeline; the files written, kept and removed; one audit row
// and one event per change. The SQL (foreign keys, the one-image rule) is in
// test/db/catalog-category-image.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-05T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1';
const CATEGORY = '01990000-0000-7000-8000-000000000d01' as Id<'Category'>;
const OTHER = '01990000-0000-7000-8000-000000000d02' as Id<'Category'>;
/** "AAAA" is base64 for three zero bytes: the fake processor never decodes it. */
const DATA = 'AAAA';

describe.each(['AU', 'ZZ'] as const)('category image use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-0000000000a3' as never) : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let images: MemoryCategoryImages;
  let files: MemoryObjectStore;
  let tree: MemoryTreeVersion;
  let audits: AuditEntry[];
  let events: PendingEvent[];
  let allowed: readonly string[];
  let refusal: ImageRefusalCode | null;
  let processed: number;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => allowed.includes(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  // `err` commits nothing and an exception commits nothing: the rows go back to what they were.
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      const saved = new Map([...images.rows].map(([id, row]) => [id, { ...row }] as const));
      const counts = { audits: audits.length, events: events.length };
      const rollback = (): void => {
        images.rows = saved;
        audits.length = counts.audits;
        events.length = counts.events;
      };
      try {
        const result = await work();
        if (!result.ok) rollback();
        return result;
      } catch (error) {
        rollback();
        throw error;
      }
    },
  } as unknown as UnitOfWork;
  const imageProcessor: ImageProcessor = {
    process: () => {
      processed += 1;
      if (refusal !== null) return Promise.resolve(err({ code: refusal }));
      return Promise.resolve(
        ok(
          (['thumb', 'medium', 'large'] as const).map((size, index) => ({
            size,
            bytes: Buffer.from(`${size}-jpeg`),
            width: 200 * (index + 1),
            height: 100 * (index + 1),
          })),
        ),
      );
    },
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox = {
    append: (_c: CallContext, batch: readonly PendingEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  };

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps: CategoryImageWriteDependencies = {
      unitOfWork,
      categoryImages: images,
      categories: tree as unknown as PlatformCategoryRepository,
      imageProcessor,
      objectStore: files,
      audit,
      outbox,
      clock: new FixedClock(T0),
      ids: new SequenceIdGenerator(new FixedClock(T0)),
    };
    return {
      set: new CategoryImageSet(gate, deps),
      remove: new CategoryImageRemove(gate, deps),
      read: new CategoryImageRead(gate, {
        unitOfWork,
        categoryImages: images,
        objectStore: files,
      }),
    };
  };

  beforeEach(() => {
    images = new MemoryCategoryImages();
    images.rows.set(CATEGORY, { status: 'hidden', version: 4, image: null });
    images.rows.set(OTHER, { status: 'archived', version: 2, image: null });
    files = new MemoryObjectStore();
    tree = new MemoryTreeVersion();
    tree.version = 7;
    audits = [];
    events = [];
    allowed = [CATALOG_CATEGORY_TREE_EDIT.key, CATALOG_CATEGORY_TREE_VIEW.key];
    refusal = null;
    processed = 0;
  });

  const keysOf = (imageId: string) =>
    ['thumb', 'medium', 'large'].map((size) => `category-images/${CATEGORY}/${imageId}/${size}`);

  describe('set', () => {
    it('writes three renditions under keys built from the ids, points the category at them and announces it', async () => {
      const { set } = build();
      const result = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      if (!result.ok) throw new Error(result.error.code);
      const imageId = result.value.image?.imageId ?? '';
      expect(result.value).toEqual({
        category: {
          id: CATEGORY,
          slug: 'dates',
          status: 'hidden',
          version: 5,
          revisionNo: 3,
          treeVersion: 7,
        },
        image: { imageId, width: 600, height: 300 },
      });
      expect([...files.objects.keys()].sort()).toEqual(keysOf(imageId).sort());
      expect(images.rows.get(CATEGORY)?.image?.uploaderAccountId).toBe(ADMIN);
      expect(images.rows.get(CATEGORY)?.image?.uploadedBytes).toBe(3);
      expect(audits.map((entry) => entry.action)).toEqual([
        'catalog.platform-category.image-changed',
      ]);
      expect(events.map((event) => event.type)).toEqual(['catalog.platform-category-changed.v1']);
      // Not structural: the tree version stays.
      expect(tree.version).toBe(7);
    });

    it('replaces the image and removes the old files after the commit', async () => {
      const { set } = build();
      const first = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      if (!first.ok) throw new Error(first.error.code);
      const oldId = first.value.image?.imageId ?? '';
      const second = await set.execute(context(), { categoryId: CATEGORY, version: 5, data: DATA });
      if (!second.ok) throw new Error(second.error.code);
      const newId = second.value.image?.imageId ?? '';
      expect(newId).not.toBe(oldId);
      expect([...files.objects.keys()].sort()).toEqual(keysOf(newId).sort());
      expect(second.value.category.version).toBe(6);
    });

    it('refuses a stale version before decoding, and leaves no file', async () => {
      const { set } = build();
      const result = await set.execute(context(), { categoryId: CATEGORY, version: 3, data: DATA });
      expect(result).toEqual(err({ code: 'conflict.stale' }));
      expect(processed).toBe(0);
      expect(files.objects.size).toBe(0);
    });

    it('answers conflict.stale and removes its files when another admin wins during the decoding', async () => {
      const { set } = build();
      const racing: ImageProcessor = imageProcessor;
      const original = racing.process.bind(racing);
      racing.process = async (bytes) => {
        const answer = await original(bytes);
        const row = images.rows.get(CATEGORY);
        if (row !== undefined) row.version += 1;
        return answer;
      };
      try {
        const result = await set.execute(context(), {
          categoryId: CATEGORY,
          version: 4,
          data: DATA,
        });
        expect(result).toEqual(err({ code: 'conflict.stale' }));
        expect(files.objects.size).toBe(0);
        expect(audits).toHaveLength(0);
        expect(events).toHaveLength(0);
      } finally {
        racing.process = original;
      }
    });

    it('removes its files and answers access.unavailable when the unit fails', async () => {
      const { set } = build();
      images.failNextReplace = true;
      const result = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      expect(result).toEqual(err({ code: 'access.unavailable' }));
      expect(files.objects.size).toBe(0);
      expect(images.rows.get(CATEGORY)?.image).toBeNull();
    });

    it.each([
      ['an unknown category', '01990000-0000-7000-8000-000000000dff', 'category.not-found'],
      ['a malformed id', 'not-an-id', 'category.not-found'],
      ['an archived category', OTHER, 'category.not-editable'],
    ])('refuses %s', async (_, categoryId, expected) => {
      const { set } = build();
      const result = await set.execute(context(), { categoryId, version: 2, data: DATA });
      expect(result).toEqual(err({ code: expected }));
      expect(processed).toBe(0);
    });

    it.each([
      ['file.unsupported-type'],
      ['file.too-small'],
      ['file.too-many-pixels'],
      ['file.unreadable'],
    ] as const)('passes the pipeline refusal %s through and writes nothing', async (code) => {
      const { set } = build();
      refusal = code;
      const result = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      expect(result).toEqual(err({ code }));
      expect(files.objects.size).toBe(0);
      expect(images.rows.get(CATEGORY)?.version).toBe(4);
    });

    it('answers a busy pipeline with a short wait', async () => {
      const { set } = build();
      refusal = 'file.busy';
      const result = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatchObject({
        code: 'access.unavailable',
        retryAfterSeconds: expect.any(Number) as number,
      });
    });

    it('refuses a picture over 4 MiB before decoding', async () => {
      const { set } = build();
      const big = 'A'.repeat(Math.ceil((4 * 1024 * 1024 * 4) / 3) + 8);
      const result = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: big });
      expect(result).toEqual(err({ code: 'file.too-large' }));
      expect(processed).toBe(0);
    });

    it.each([
      ['no data', { categoryId: CATEGORY, version: 4 }, 'data', 'required'],
      ['empty data', { categoryId: CATEGORY, version: 4, data: '' }, 'data', 'required'],
      [
        'data that is not base64',
        { categoryId: CATEGORY, version: 4, data: 'ab!d' },
        'data',
        'format',
      ],
      ['a text version', { categoryId: CATEGORY, version: '4', data: DATA }, 'version', 'type'],
    ])('refuses %s', async (_, input, path, fieldCode) => {
      const { set } = build();
      const result = await set.execute(context(), input);
      expect(result).toEqual(
        err({ code: 'validation.failed', fields: [{ path, code: fieldCode }] }),
      );
    });

    it('refuses an unknown key', async () => {
      const { set } = build();
      const result = await set.execute(context(), {
        categoryId: CATEGORY,
        version: 4,
        data: DATA,
        imageId: CATEGORY,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('validation.failed');
    });

    it('refuses an acting-as session, a seller and a caller without the key', async () => {
      const { set } = build();
      const input = { categoryId: CATEGORY, version: 4, data: DATA };
      expect((await set.execute(actingAs(), input)).ok).toBe(false);
      expect((await set.execute(context('seller'), input)).ok).toBe(false);
      allowed = [CATALOG_CATEGORY_TREE_VIEW.key];
      expect((await set.execute(context(), input)).ok).toBe(false);
      expect(processed).toBe(0);
      expect(files.objects.size).toBe(0);
    });
  });

  describe('remove', () => {
    it('clears the image, removes its files and announces it', async () => {
      const { set, remove } = build();
      const first = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      if (!first.ok) throw new Error(first.error.code);
      audits.length = 0;
      events.length = 0;
      const result = await remove.execute(context(), { categoryId: CATEGORY, version: 5 });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.image).toBeNull();
      expect(result.value.category.version).toBe(6);
      expect(files.objects.size).toBe(0);
      expect(audits.map((entry) => entry.action)).toEqual([
        'catalog.platform-category.image-changed',
      ]);
      expect(events.map((event) => event.type)).toEqual(['catalog.platform-category-changed.v1']);
    });

    it('answers a category with no image as it is and writes nothing', async () => {
      const { remove } = build();
      const result = await remove.execute(context(), { categoryId: CATEGORY, version: 4 });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.category.version).toBe(4);
      expect(audits).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it.each([
      ['a stale version', { categoryId: CATEGORY, version: 9 }, 'conflict.stale'],
      ['an archived category', { categoryId: OTHER, version: 2 }, 'category.not-editable'],
      [
        'an unknown category',
        { categoryId: '01990000-0000-7000-8000-000000000dff', version: 1 },
        'category.not-found',
      ],
    ])('refuses %s', async (_, input, expected) => {
      const { remove } = build();
      expect(await remove.execute(context(), input)).toEqual(err({ code: expected }));
    });

    it('refuses an acting-as session', async () => {
      const { remove } = build();
      const result = await remove.execute(actingAs(), { categoryId: CATEGORY, version: 4 });
      expect(result.ok).toBe(false);
    });
  });

  describe('read', () => {
    it('serves a rendition of the current image to a reader, and nothing else', async () => {
      const { set, read } = build();
      const first = await set.execute(context(), { categoryId: CATEGORY, version: 4, data: DATA });
      if (!first.ok) throw new Error(first.error.code);
      const imageId = first.value.image?.imageId ?? '';
      allowed = [CATALOG_CATEGORY_TREE_VIEW.key];
      const served = await read.execute(context(), {
        categoryId: CATEGORY,
        imageId,
        size: 'medium',
      });
      if (!served.ok) throw new Error(served.error.code);
      expect(served.value.bytes.toString()).toBe('medium-jpeg');
      expect(served.value.contentType).toBe('image/jpeg');

      const notCurrent = await read.execute(context(), {
        categoryId: CATEGORY,
        imageId: OTHER,
        size: 'medium',
      });
      expect(notCurrent).toEqual(err({ code: 'image.not-found' }));
      const otherCategory = await read.execute(context(), {
        categoryId: OTHER,
        imageId,
        size: 'medium',
      });
      expect(otherCategory).toEqual(err({ code: 'image.not-found' }));
      const badSize = await read.execute(context(), { categoryId: CATEGORY, imageId, size: 'raw' });
      expect(!badSize.ok && badSize.error.code).toBe('validation.failed');
    });

    it('refuses a seller and a caller without the view key', async () => {
      const { read } = build();
      const input = { categoryId: CATEGORY, imageId: CATEGORY, size: 'thumb' };
      expect((await read.execute(context('seller'), input)).ok).toBe(false);
      allowed = [];
      expect((await read.execute(context(), input)).ok).toBe(false);
    });
  });
});
