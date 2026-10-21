import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { InMemoryCounters } from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import type { StoreImageProcessor } from '../ports/store-image-processor';
import { SELLERS_STORE_PROFILE_VIEW } from '../../contracts/permissions';
import { MarketConfigStoreProfileLocales } from '../../infrastructure/market-config-store-profile-locales';
import { SharpStoreImageProcessor } from '../../infrastructure/sharp-store-image-processor';
import { InMemoryStoreProfiles } from '../testing/in-memory-store-profiles';
import {
  FakeClaimCheck,
  FakeContentSealer,
  InMemoryStoreContent,
  InMemoryStoreImages,
  MapObjectStore,
} from '../testing/in-memory-store-profile';
import { PublishedAboutCache } from '../store-profile/published-about-cache';
import { PublishedStoreContentReader } from '../store-profile/published-store-content';
import { StoreImageReadOwn } from './store-image-read-own.use-case';
import { StoreImageRemove } from './store-image-remove.use-case';
import { StoreImageSave } from './store-image-save.use-case';
import { StoreProfileRead } from './store-profile-read.use-case';
import { StoreProfileSaveAbout } from './store-profile-save-about.use-case';

// The seller's own store profile in memory (sellers design 3.7; slice 12 part 2) on both Market
// fixtures: AU (one locale, en-AU) and the synthetic ZZ (ja-JP default and en-US). PostgreSQL is
// covered by test/db/sellers-store-profile.db-spec.ts; the HTTP mapping by
// test/store-profile.e2e.spec.ts.

const START = Temporal.Instant.from('2026-10-15T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const market = (code: string): MarketContext => testMarketContext(code, 'default');

const MARKETS = [
  { code: 'AU', locale: 'en-AU', locales: ['en-AU'] },
  { code: 'ZZ', locale: 'ja-JP', locales: ['ja-JP', 'en-US'] },
] as const;

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const profiles = new InMemoryStoreProfiles();
  const storeContent = new InMemoryStoreContent();
  const storeImages = new InMemoryStoreImages();
  const contentSealer = new FakeContentSealer();
  const claimCheck = new FakeClaimCheck();
  const objectStore = new MapObjectStore();
  const counters = new InMemoryCounters();
  const audits: AuditEntry[] = [];
  const events: { type: string; payload: unknown; aggregateVersion: number }[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox: OutboxWriter = {
    append: (_context, pending) => {
      for (const event of pending) {
        events.push(event);
      }
      return Promise.resolve();
    },
  };
  let allowed = true;
  // null: every key is held; a set: only these keys are (a seller who may view but not edit).
  let held: ReadonlySet<string> | null = null;
  const authorisation: AuthorisationCheck = {
    check: (_context, declaration) => {
      const keys = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
      const ok = allowed && (held === null || keys.every((key) => held!.has(key)));
      return Promise.resolve(
        ok ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  // The real processor, counted, so a test sees that a refused request never decoded anything.
  const real = new SharpStoreImageProcessor();
  const imageProcessor = {
    calls: 0,
    busy: false,
    process(kind, bytes) {
      this.calls += 1;
      if (this.busy) return Promise.resolve({ ok: false, error: { code: 'file.busy' } });
      return real.process(kind, bytes);
    },
  } as StoreImageProcessor & { calls: number; busy: boolean };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const localesPolicy = new MarketConfigStoreProfileLocales(markets);
  const reading = {
    unitOfWork,
    storeProfiles: profiles,
    storeContent,
    storeImages,
    contentSealer,
    localesPolicy,
  };
  const counterKeys = new HmacRateCounterKeys(new Uint8Array(32).fill(7));
  const aboutCache = new PublishedAboutCache(clock);
  return {
    clock,
    ids,
    profiles,
    storeContent,
    storeImages,
    contentSealer,
    claimCheck,
    objectStore,
    counters,
    audits,
    events,
    aboutCache,
    imageProcessor,
    deny: () => void (allowed = false),
    holdOnly: (...keys: string[]) => void (held = new Set(keys)),
    read: new StoreProfileRead(gate, reading),
    saveAbout: new StoreProfileSaveAbout(gate, {
      ...reading,
      audit,
      outbox,
      counters,
      counterKeys,
      claimCheck,
      ids,
      clock,
    }),
    saveImage: new StoreImageSave(gate, {
      ...reading,
      imageProcessor,
      objectStore,
      audit,
      counters,
      counterKeys,
      ids,
      clock,
    }),
    removeImage: new StoreImageRemove(gate, {
      ...reading,
      objectStore,
      audit,
      counters,
      counterKeys,
      clock,
    }),
    readImage: new StoreImageReadOwn(gate, {
      unitOfWork,
      storeProfiles: profiles,
      storeImages,
      objectStore,
    }),
    published: new PublishedStoreContentReader({
      unitOfWork,
      storeContent,
      storeImages,
      contentSealer,
      localesPolicy,
      aboutCache,
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

function ownerOf(t: Setup, code: string, approved = true) {
  const sellerId = t.ids.next<'Seller'>();
  t.profiles.put(market(code), sellerId, { approved });
  t.storeContent.addProfile(market(code), sellerId);
  return { sellerId, context: contextOf(t, code, sellerId) };
}

function contextOf(t: Setup, code: string, sellerId: Id<'Seller'>): CallContext {
  return testCallContext(
    market(code),
    testAuthenticatedActor(market(code), {
      population: 'seller',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
}

const picture = async (width: number, height: number, format: 'png' | 'jpeg' = 'png') =>
  (
    await sharp({ create: { width, height, channels: 3, background: '#1a7a5a' } })
      [format]()
      .toBuffer()
  ).toString('base64');

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(MARKETS)('sellers store profile in $code (design 3.7)', (fixture) => {
  const { code, locale, locales } = fixture;
  const TEXT = 'Family bakery. We bake bread and cakes\nevery morning.';

  describe('reading', () => {
    it('reads an empty profile: version 0, a blank text per locale, no images', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.read.execute(context, {});

      expect(result).toEqual({
        ok: true,
        value: {
          version: 0,
          about: Object.fromEntries(locales.map((l) => [l, ''])),
          defaultLocale: locale,
          locales,
          logo: null,
          banner: null,
        },
      });
    });

    it('is access.denied for a seller whose file is not approved, and for a refused actor', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code, false);
      expect(await t.read.execute(context, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });

      const other = setUp();
      const owner = ownerOf(other, code);
      other.deny();
      expect(await other.read.execute(owner.context, {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('is file.not-found for a seller with no store profile row', async () => {
      const t = setUp();
      const context = contextOf(t, code, t.ids.next<'Seller'>());

      expect(await t.read.execute(context, {})).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
    });

    it('reads no text, and still answers, for an erased seller (destroyed key)', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });
      t.contentSealer.destroyed.add(`${market(code).marketId}|${sellerId}`);

      const result = await t.read.execute(context, {});

      expect(result).toMatchObject({ ok: true, value: { version: 1, about: { [locale]: '' } } });
    });
  });

  describe('saving the About text', () => {
    it('saves, publishes at once, and reads back the same text and the next version', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);

      const saved = await t.saveAbout.execute(context, {
        expectedVersion: 0,
        about: { [locale]: `  ${TEXT}  ` },
      });

      expect(saved).toMatchObject({
        ok: true,
        value: { version: 1, about: { [locale]: TEXT } },
      });
      const reader = await t.published.profileOf(context, sellerId);
      expect(reader.about).toBe(TEXT);
    });

    it('keeps the text out of the stored row, the audit entry and the event', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);

      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });

      const revision = [...t.storeContent.revisions.values()][0]!;
      expect(revision.ciphertext).not.toContain('bakery');
      expect(t.audits).toEqual([
        expect.objectContaining({
          action: 'sellers.store-profile.saved',
          targetId: sellerId,
          after: { revisionId: expect.any(String) as unknown, revisionNo: 1 },
        }),
      ]);
      expect(t.events).toEqual([
        expect.objectContaining({
          type: 'sellers.store-profile-published.v1',
          aggregateVersion: 1,
          payload: { sellerId, revisionId: expect.any(String) as unknown },
        }),
      ]);
      const everything = JSON.stringify([t.audits, t.events]);
      expect(everything).not.toContain('bakery');
      expect(everything).not.toContain(revision.hash);
    });

    it('writes nothing when the text is the same as the published one', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });

      const again = await t.saveAbout.execute(context, {
        expectedVersion: 1,
        about: { [locale]: TEXT },
      });

      expect(again).toMatchObject({ ok: true, value: { version: 1 } });
      expect(t.storeContent.revisions.size).toBe(1);
      expect(t.audits).toHaveLength(1);
      expect(t.events).toHaveLength(1);
    });

    it('clears a locale with an empty text, and rolling back is saving the old text again', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });

      const cleared = await t.saveAbout.execute(context, {
        expectedVersion: 1,
        about: { [locale]: '   ' },
      });
      const back = await t.saveAbout.execute(context, {
        expectedVersion: 2,
        about: { [locale]: TEXT },
      });

      expect(cleared).toMatchObject({ ok: true, value: { version: 2, about: { [locale]: '' } } });
      expect(back).toMatchObject({ ok: true, value: { version: 3, about: { [locale]: TEXT } } });
    });

    it('refuses a stale expectedVersion with conflict.stale and writes nothing', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });

      const stale = await t.saveAbout.execute(context, {
        expectedVersion: 0,
        about: { [locale]: 'Another text' },
      });

      expect(stale).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(t.storeContent.revisions.size).toBe(1);
    });

    it.each([
      ['a link', 'Visit https://shop.example.com now', 'url'],
      ['a host name', 'Find us at bakery.example.com', 'url'],
      ['a control character', 'Fresh\u0007bread', 'characters'],
      ['a bidi override', 'Fresh ‮bread', 'characters'],
      ['too many characters', 'x'.repeat(2001), 'length'],
    ])('refuses a text with %s, naming the locale and the rule only', async (_, text, rule) => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveAbout.execute(context, {
        expectedVersion: 0,
        about: { [locale]: text },
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: `about.${locale}`, code: rule }] },
      });
      expect(t.storeContent.revisions.size).toBe(0);
      expect(t.claimCheck.calls).toBe(0);
    });

    it('accepts exactly 2000 characters', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveAbout.execute(context, {
        expectedVersion: 0,
        about: { [locale]: 'あ'.repeat(2000) },
      });

      expect(result.ok).toBe(true);
    });

    it.each([
      ['a locale the Market does not offer', { 'xx-XX': 'text' }, 'about'],
      ['a text that is not a string', { [locale]: 12 }, `about.${locale}`],
    ])('refuses %s', async (_, about, path) => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveAbout.execute(context, { expectedVersion: 0, about });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path }] },
      });
    });

    it.each([[-1], [1.5], ['0'], [undefined]])(
      'refuses expectedVersion %p',
      async (expectedVersion) => {
        const t = setUp();
        const { context } = ownerOf(t, code);

        const result = await t.saveAbout.execute(context, {
          expectedVersion,
          about: { [locale]: TEXT },
        });

        expect(result).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'expectedVersion', code: 'format' }],
          },
        });
      },
    );

    it('refuses a text that claims a certification, as about.<locale> claim-term', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveAbout.execute(context, {
        expectedVersion: 0,
        about: { [locale]: 'We are Claim Word bakers' },
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: `about.${locale}`, code: 'claim-term' }],
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/claim word/i);
      expect(t.storeContent.revisions.size).toBe(0);
    });

    it('fails closed when the claim check is unavailable: sellers.unavailable, nothing saved', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      t.claimCheck.unavailable = true;

      const result = await t.saveAbout.execute(context, {
        expectedVersion: 0,
        about: { [locale]: TEXT },
      });

      expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
      expect(t.storeContent.revisions.size).toBe(0);
    });

    it('is request.throttled once the saves limit is spent', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      let last: unknown;
      for (let i = 0; i < 61; i += 1) {
        last = await t.saveAbout.execute(context, { expectedVersion: 99, about: {} });
      }

      expect(last).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
    });

    it('is access.denied for a seller who is not approved, and file.not-found without a profile', async () => {
      const t = setUp();
      const pending = ownerOf(t, code, false);
      expect(
        await t.saveAbout.execute(pending.context, {
          expectedVersion: 0,
          about: { [locale]: TEXT },
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });

      const none = contextOf(t, code, t.ids.next<'Seller'>());
      expect(
        await t.saveAbout.execute(none, { expectedVersion: 0, about: { [locale]: TEXT } }),
      ).toEqual({ ok: false, error: { code: 'file.not-found' } });
    });

    it('keeps one seller from touching another: the seller is the actor, never the request', async () => {
      const t = setUp();
      const a = ownerOf(t, code);
      const b = ownerOf(t, code);
      await t.saveAbout.execute(a.context, { expectedVersion: 0, about: { [locale]: TEXT } });

      expect(await t.published.profileOf(b.context, b.sellerId)).toMatchObject({ about: null });
      expect(await t.read.execute(b.context, {})).toMatchObject({ value: { version: 0 } });
    });
  });

  describe('the public About text and its cache (Hassan M5)', () => {
    it('opens a revision once and serves it from the cache until the TTL ends', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });
      const opened = t.contentSealer.opens;

      await t.published.profileOf(context, sellerId);
      await t.published.profileOf(context, sellerId);
      await t.published.profileOf(context, sellerId);

      expect(t.contentSealer.opens - opened).toBe(1);
      t.clock.advance(Temporal.Duration.from({ minutes: 10 }));
      expect((await t.published.profileOf(context, sellerId)).about).toBe(TEXT);
      expect(t.contentSealer.opens - opened).toBe(2);
    });

    it('shows a new save at once: the pointer is read every time, a new revision is a new key', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: 'First' } });
      expect((await t.published.profileOf(context, sellerId)).about).toBe('First');

      await t.saveAbout.execute(context, { expectedVersion: 1, about: { [locale]: 'Second' } });

      expect((await t.published.profileOf(context, sellerId)).about).toBe('Second');
    });

    it('shows the text of the Market default locale only, and null where it has none', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);
      const other = locales.find((l) => l !== locale);
      if (other !== undefined) {
        await t.saveAbout.execute(context, {
          expectedVersion: 0,
          about: { [other]: 'Only other' },
        });
        expect((await t.published.profileOf(context, sellerId)).about).toBeNull();
      }
      await t.saveAbout.execute(context, {
        expectedVersion: other === undefined ? 0 : 1,
        about: { [locale]: TEXT },
      });

      expect((await t.published.profileOf(context, sellerId)).about).toBe(TEXT);
    });

    it('shows no text for an erased seller and does not fail the page', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);
      await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } });
      t.contentSealer.destroyed.add(`${market(code).marketId}|${sellerId}`);
      t.clock.advance(Temporal.Duration.from({ minutes: 11 }));

      expect((await t.published.profileOf(context, sellerId)).about).toBeNull();
    });

    it('does not mix two Markets or two sellers in the cache', async () => {
      const t = setUp();
      const a = ownerOf(t, code);
      const b = ownerOf(t, code);
      await t.saveAbout.execute(a.context, { expectedVersion: 0, about: { [locale]: 'Text A' } });
      await t.saveAbout.execute(b.context, { expectedVersion: 0, about: { [locale]: 'Text B' } });

      expect((await t.published.profileOf(a.context, a.sellerId)).about).toBe('Text A');
      expect((await t.published.profileOf(b.context, b.sellerId)).about).toBe('Text B');
    });
  });

  describe('the logo and the banner', () => {
    it('saves a logo: two renditions stored, the ref in the view, one audit row', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);

      const result = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(600, 400),
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          logo: { id: expect.any(String) as unknown, width: 512, height: 512 },
          banner: null,
        },
      });
      const keys = [...t.objectStore.objects.keys()];
      expect(keys).toHaveLength(2);
      expect(keys.every((key) => key.startsWith(`${sellerId}/store-images/`))).toBe(true);
      expect(t.audits).toEqual([
        expect.objectContaining({
          action: 'sellers.store-image.changed',
          targetId: sellerId,
          before: { imageId: null },
          after: { kind: 'logo', imageId: expect.any(String) as unknown },
        }),
      ]);
    });

    it('saves a banner of 1536 by 384', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveImage.execute(context, {
        kind: 'banner',
        data: await picture(2000, 900, 'jpeg'),
      });

      expect(result).toMatchObject({ ok: true, value: { banner: { width: 1536, height: 384 } } });
    });

    it('replaces an image: the old renditions are deleted after the new one is current', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      const first = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(300, 300),
      });
      const firstKeys = [...t.objectStore.objects.keys()];

      const second = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(400, 400),
      });

      expect(first.ok && second.ok).toBe(true);
      expect(t.objectStore.objects.size).toBe(2);
      expect(firstKeys.some((key) => t.objectStore.objects.has(key))).toBe(false);
      expect(t.audits[1]).toMatchObject({
        before: { imageId: first.ok ? first.value.logo?.id : '' },
      });
    });

    it.each([
      ['too small', () => picture(100, 100), 'file.too-small'],
      [
        'not a picture',
        () => Promise.resolve(Buffer.from('hello').toString('base64')),
        'file.unsupported-type',
      ],
    ])('refuses a logo that is %s and stores nothing', async (_, data, refusal) => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveImage.execute(context, { kind: 'logo', data: await data() });

      expect(result).toEqual({ ok: false, error: { code: refusal } });
      expect(t.objectStore.objects.size).toBe(0);
      expect(t.audits).toEqual([]);
    });

    it('refuses a base64 text over the 4 MiB limit as file.too-large before decoding', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const result = await t.saveImage.execute(context, {
        kind: 'logo',
        data: 'A'.repeat(5_700_000),
      });

      expect(result).toEqual({ ok: false, error: { code: 'file.too-large' } });
    });

    it.each([
      [{ kind: 'avatar', data: 'AAAA' }, 'kind', 'format'],
      [{ kind: 'logo' }, 'data', 'required'],
      [{ kind: 'logo', data: '' }, 'data', 'required'],
      [{ kind: 'logo', data: 'not base64!!' }, 'data', 'format'],
    ])('refuses a bad request %j with validation.failed', async (input, path, rule) => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      expect(await t.saveImage.execute(context, input)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: rule }] },
      });
    });

    it('removes the objects it wrote when the object store fails part way', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      t.objectStore.failAfterPuts = 1;

      const result = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(300, 300),
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(t.objectStore.objects.size).toBe(0);
      expect(t.storeImages.current.size).toBe(0);
    });

    it('is access.denied for a seller who is not approved, with no decoding and no object', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code, false);

      const result = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(300, 300),
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(t.objectStore.objects.size).toBe(0);
    });

    it('removes an image: the row goes, the objects go after, one audit row', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      const saved = await t.saveImage.execute(context, {
        kind: 'banner',
        data: await picture(1600, 500),
      });

      const removed = await t.removeImage.execute(context, { kind: 'banner' });

      expect(removed).toMatchObject({ ok: true, value: { banner: null } });
      expect(t.objectStore.objects.size).toBe(0);
      expect(t.audits).toHaveLength(2);
      expect(t.audits[1]).toMatchObject({
        before: { imageId: saved.ok ? saved.value.banner?.id : '' },
        after: { kind: 'banner' },
      });
    });

    it('removing what is not there is not an error and audits nothing', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      const removed = await t.removeImage.execute(context, { kind: 'logo' });

      expect(removed).toMatchObject({ ok: true, value: { logo: null } });
      expect(t.audits).toEqual([]);
    });

    it('refuses an unknown kind on remove', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);

      expect(await t.removeImage.execute(context, { kind: 'avatar' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('serves the seller their own current image, and only that one, as the sizes it stored', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      const saved = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(600, 400),
      });
      const id = saved.ok ? saved.value.logo!.id : '';

      const small = await t.readImage.execute(context, { imageId: id, size: 'small' });
      const large = await t.readImage.execute(context, { imageId: id, size: 'large' });

      expect(small.ok && small.value.contentType).toBe('image/jpeg');
      expect((await sharp(small.ok ? small.value.bytes : Buffer.alloc(0)).metadata()).width).toBe(
        128,
      );
      expect((await sharp(large.ok ? large.value.bytes : Buffer.alloc(0)).metadata()).width).toBe(
        512,
      );
    });

    it.each([
      ['an unknown size', (id: string) => ({ imageId: id, size: 'huge' })],
      ['an id that is not an id', () => ({ imageId: '../etc', size: 'small' })],
      [
        'an id that does not exist',
        () => ({ imageId: '0199dddd-0000-7000-8000-000000000999', size: 'small' }),
      ],
    ])('answers image.not-found for %s', async (_, input) => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      const saved = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(300, 300),
      });

      expect(
        await t.readImage.execute(context, input(saved.ok ? saved.value.logo!.id : '')),
      ).toEqual({
        ok: false,
        error: { code: 'image.not-found' },
      });
    });

    it("answers image.not-found for a replaced image and for another seller's image alike", async () => {
      const t = setUp();
      const mine = ownerOf(t, code);
      const theirs = ownerOf(t, code);
      const first = await t.saveImage.execute(mine.context, {
        kind: 'logo',
        data: await picture(300, 300),
      });
      const firstId = first.ok ? first.value.logo!.id : '';
      await t.saveImage.execute(mine.context, { kind: 'logo', data: await picture(400, 400) });

      const replaced = await t.readImage.execute(mine.context, { imageId: firstId, size: 'small' });
      const crossed = await t.readImage.execute(theirs.context, {
        imageId: firstId,
        size: 'small',
      });

      expect(replaced).toEqual({ ok: false, error: { code: 'image.not-found' } });
      expect(crossed).toEqual(replaced);
    });

    describe('refused pictures store nothing (S2)', () => {
      const animatedWebp = async () => {
        const frame = (background: string) =>
          sharp({ create: { width: 300, height: 300, channels: 3, background } })
            .png()
            .toBuffer();
        return sharp([await frame('#fff'), await frame('#000')], { join: { animated: true } })
          .webp({ loop: 0, delay: [100, 100] })
          .toBuffer();
      };
      const solid = (width: number, height: number) =>
        sharp({ create: { width, height, channels: 3, background: '#224488' } })
          .png()
          .toBuffer();

      it.each([
        ['12001 pixels wide', () => solid(12001, 300), 'banner', 'file.too-many-pixels'],
        ['more than 24 million pixels', () => solid(4900, 4900), 'logo', 'file.too-many-pixels'],
        ['an animated WebP', animatedWebp, 'logo', 'file.unsupported-type'],
        [
          'a GIF',
          () => Promise.resolve(Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')),
          'logo',
          'file.unsupported-type',
        ],
        [
          'a damaged JPEG',
          () =>
            Promise.resolve(
              Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]),
            ),
          'logo',
          'file.unreadable',
        ],
      ])('refuses %s with no object, no row and no audit', async (_, make, kind, refusal) => {
        const t = setUp();
        const { context } = ownerOf(t, code);
        const data = (await make()).toString('base64');

        const result = await t.saveImage.execute(context, { kind, data });

        expect(result).toEqual({ ok: false, error: { code: refusal } });
        expect(t.objectStore.objects.size).toBe(0);
        expect(t.storeImages.current.size).toBe(0);
        expect(t.audits).toEqual([]);
      });
    });

    describe('permissions (S3)', () => {
      it('refuses every write and the own-image read without the permission: nothing decoded, stored or audited', async () => {
        const t = setUp();
        const { context } = ownerOf(t, code);
        const saved = await t.saveImage.execute(context, {
          kind: 'logo',
          data: await picture(300, 300),
        });
        const id = saved.ok ? saved.value.logo!.id : '';
        const decodedBefore = t.imageProcessor.calls;
        const objectsBefore = t.objectStore.objects.size;
        const auditsBefore = t.audits.length;
        t.deny();

        const refusals = [
          await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } }),
          await t.saveImage.execute(context, { kind: 'banner', data: await picture(1600, 500) }),
          await t.removeImage.execute(context, { kind: 'logo' }),
          await t.readImage.execute(context, { imageId: id, size: 'small' }),
          await t.read.execute(context, {}),
        ];

        for (const refusal of refusals) {
          expect(refusal).toEqual({ ok: false, error: { code: 'access.denied' } });
        }
        expect(t.imageProcessor.calls).toBe(decodedBefore);
        expect(t.objectStore.objects.size).toBe(objectsBefore);
        expect(t.audits).toHaveLength(auditsBefore);
        expect(t.storeContent.revisions.size).toBe(0);
        expect(t.storeImages.current.size).toBe(1);
      });

      it('lets a seller who may view but not edit read, and refuses every write', async () => {
        const t = setUp();
        const { context } = ownerOf(t, code);
        const saved = await t.saveImage.execute(context, {
          kind: 'logo',
          data: await picture(300, 300),
        });
        const id = saved.ok ? saved.value.logo!.id : '';
        const decodedBefore = t.imageProcessor.calls;
        t.holdOnly(SELLERS_STORE_PROFILE_VIEW.key);

        expect(await t.read.execute(context, {})).toMatchObject({ ok: true });
        expect(await t.readImage.execute(context, { imageId: id, size: 'small' })).toMatchObject({
          ok: true,
        });
        for (const refusal of [
          await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } }),
          await t.saveImage.execute(context, { kind: 'logo', data: await picture(300, 300) }),
          await t.removeImage.execute(context, { kind: 'logo' }),
        ]) {
          expect(refusal).toEqual({ ok: false, error: { code: 'access.denied' } });
        }
        expect(t.imageProcessor.calls).toBe(decodedBefore);
        expect(t.storeContent.revisions.size).toBe(0);
        expect(t.storeImages.current.size).toBe(1);
      });

      it('refuses an unauthenticated caller, and a seller that is not approved, on remove and own-read', async () => {
        const t = setUp();
        const pending = ownerOf(t, code, false);
        const anonymous = testCallContext(market(code), 'anonymous');
        const imageId = '0199dddd-0000-7000-8000-000000000999';

        expect(await t.removeImage.execute(anonymous, { kind: 'logo' })).toMatchObject({
          ok: false,
          error: { code: 'access.unauthenticated' },
        });
        expect(await t.readImage.execute(anonymous, { imageId, size: 'small' })).toMatchObject({
          ok: false,
          error: { code: 'access.unauthenticated' },
        });
        expect(await t.removeImage.execute(pending.context, { kind: 'logo' })).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        expect(await t.readImage.execute(pending.context, { imageId, size: 'small' })).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        expect(t.audits).toEqual([]);
      });
    });

    describe('the picture rate limit (H2, S4)', () => {
      const bad = { kind: 'avatar', data: 'AAAA' };

      it('spends its own counters, not the text saves', async () => {
        const t = setUp();
        const { context } = ownerOf(t, code);

        await t.saveImage.execute(context, { kind: 'logo', data: await picture(300, 300) });
        await t.removeImage.execute(context, { kind: 'logo' });

        expect(t.counters.countOf('store-image.account.minute')).toBe(2);
        expect(t.counters.countOf('store-image.account.day')).toBe(2);
        expect(t.counters.countOf('save.account.minute')).toBe(0);
      });

      it('allows 10 a minute for an account across saves and removals, then throttles both', async () => {
        const t = setUp();
        const { context } = ownerOf(t, code);
        for (let i = 0; i < 5; i += 1) {
          expect((await t.saveImage.execute(context, bad)).ok).toBe(false);
          expect((await t.removeImage.execute(context, { kind: 'avatar' })).ok).toBe(false);
        }

        const save = await t.saveImage.execute(context, bad);
        const remove = await t.removeImage.execute(context, { kind: 'logo' });

        for (const answer of [save, remove]) {
          expect(answer).toMatchObject({
            ok: false,
            error: { code: 'request.throttled', retryAfterSeconds: expect.any(Number) as unknown },
          });
        }
        // The About text save has its own, larger limit and still works.
        expect(
          await t.saveAbout.execute(context, { expectedVersion: 0, about: { [locale]: TEXT } }),
        ).toMatchObject({ ok: true });
      });

      it('counts per account: another account of the Market is not affected', async () => {
        const t = setUp();
        const first = ownerOf(t, code);
        const second = ownerOf(t, code);
        for (let i = 0; i < 11; i += 1) await t.saveImage.execute(first.context, bad);

        expect(await t.saveImage.execute(first.context, bad)).toMatchObject({
          error: { code: 'request.throttled' },
        });
        expect(await t.saveImage.execute(second.context, bad)).toMatchObject({
          error: { code: 'validation.failed' },
        });
      });

      it('counts per Market: the same account id in the other Market starts at zero', async () => {
        const t = setUp();
        const here = ownerOf(t, code);
        const otherCode = code === 'AU' ? 'ZZ' : 'AU';
        const sellerId = t.ids.next<'Seller'>();
        t.profiles.put(market(otherCode), sellerId, { approved: true });
        t.storeContent.addProfile(market(otherCode), sellerId);
        const accountId =
          here.context.actor.kind === 'authenticated' ? here.context.actor.accountId : null;
        const there = testCallContext(
          market(otherCode),
          testAuthenticatedActor(market(otherCode), {
            population: 'seller',
            accountId: accountId!,
            sessionId: t.ids.next<'Session'>(),
            sellerId,
          }),
        );
        for (let i = 0; i < 11; i += 1) await t.saveImage.execute(here.context, bad);

        expect(await t.saveImage.execute(here.context, bad)).toMatchObject({
          error: { code: 'request.throttled' },
        });
        expect(await t.saveImage.execute(there, bad)).toMatchObject({
          error: { code: 'validation.failed' },
        });
      });
    });

    it('answers access.unavailable with a short wait when the picture pipeline is busy, and stores nothing', async () => {
      const t = setUp();
      const { context } = ownerOf(t, code);
      t.imageProcessor.busy = true;

      const result = await t.saveImage.execute(context, {
        kind: 'logo',
        data: await picture(300, 300),
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'access.unavailable', retryAfterSeconds: 2 },
      });
      expect(t.objectStore.objects.size).toBe(0);
      expect(t.audits).toEqual([]);
    });

    it('shows the logo and banner refs to the public reader, and the logo in a list read', async () => {
      const t = setUp();
      const { sellerId, context } = ownerOf(t, code);
      await t.saveImage.execute(context, { kind: 'logo', data: await picture(600, 400) });
      await t.saveImage.execute(context, { kind: 'banner', data: await picture(1600, 500) });

      const profile = await t.published.profileOf(context, sellerId);
      const logos = await t.published.logosOf(context, [sellerId, t.ids.next<'Seller'>()]);

      expect(profile.logo).toMatchObject({ width: 512, height: 512 });
      expect(profile.banner).toMatchObject({ width: 1536, height: 384 });
      expect([...logos.keys()]).toEqual([sellerId]);
    });
  });
});
