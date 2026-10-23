import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemorySlides } from '../../../../test/support/memory-slide-repository';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { STOREFRONT_SLIDE_EDIT, STOREFRONT_SLIDE_READ } from '../contracts/permissions';
import { STOREFRONT_AUDIT_ACTIONS } from '../domain/audit';
import type { SlideCopyPackage, SlideDetailView, SlideSummaryView } from './slide-flow';
import type { StorefrontDependencies } from './storefront-dependencies';
import { ArchiveStorefrontSlide } from './use-cases/archive-slide.use-case';
import { CreateStorefrontSlide } from './use-cases/create-slide.use-case';
import { ListStorefrontSlides } from './use-cases/list-slides.use-case';
import { PrepareStorefrontSlideCopy } from './use-cases/prepare-slide-copy.use-case';
import { RestoreStorefrontSlideVersion } from './use-cases/restore-slide-version.use-case';
import { UpdateStorefrontSlideDraft } from './use-cases/update-slide-draft.use-case';
import { ViewStorefrontSlide } from './use-cases/view-slide.use-case';

// The slide library use cases in memory on both Market fixtures, behind a gate that grants each
// actor only its own keys: a reader sees slides; an editor also creates, changes, restores,
// copies out and archives. Every slide belongs to one Market, and one Market never finds another's.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-23T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const READER = id<'Account'>(0x5e);
const EDITOR = id<'Account'>(0xed);
const CATEGORY = id<'Category'>(0xca).toString();
const ACTIONS = new Set<string>(STOREFRONT_AUDIT_ACTIONS.map((a) => a.action));
const KEYS = new Map<string, string[]>([
  [READER, [STOREFRONT_SLIDE_READ.key]],
  [EDITOR, [STOREFRONT_SLIDE_READ.key, STOREFRONT_SLIDE_EDIT.key]],
]);

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([
  ['AU', 'ZZ'],
  ['ZZ', 'AU'],
] as const)('storefront slides in market %s (other market %s)', (code, otherCode) => {
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(otherCode, 'default');
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, {
    check: (context: CallContext, declaration: AccessDeclaration) => {
      const actor = context.actor;
      const held = (actor.kind === 'authenticated' ? KEYS.get(actor.accountId) : undefined) ?? [];
      const rule = declaration.rule;
      const allowed = rule.kind !== 'permissions' || rule.allOf.every((key) => held.includes(key));
      return Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  });
  const actorIn = (
    target: MarketContext,
    accountId: Id<'Account'>,
    population: 'admin' | 'seller' = 'admin',
  ) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `sl-${accountId.slice(-4)}-${target.marketId.toLowerCase()}-abcd`,
    );
  const reader = actorIn(market, READER);
  const editor = actorIn(market, EDITOR);
  const otherEditor = actorIn(otherMarket, EDITOR);
  const otherReader = actorIn(otherMarket, READER);
  const buyer = testCallContext(market, 'anonymous');
  const seller = actorIn(market, EDITOR, 'seller');

  let slides: MemorySlides;
  let audit: RecordingAudit;
  let deps: StorefrontDependencies;
  beforeEach(() => {
    slides = new MemorySlides();
    audit = new RecordingAudit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      pages: undefined as never,
      slides,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  type Answer =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
  type Runnable = new (
    g: typeof gate,
    d: StorefrontDependencies,
  ) => { execute(c: CallContext, i: never): Promise<Answer> };
  const run = (type: Runnable, context: CallContext, input: unknown): Promise<Answer> =>
    new type(gate, deps).execute(context, input as never);
  const value = async <T>(promise: Promise<Answer>): Promise<T> => {
    const result = await promise;
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
    return result.value as T;
  };
  const errorOf = async (promise: Promise<Answer>) => {
    const result = await promise;
    return result.ok ? 'allowed' : result.error;
  };
  const DENIED = { code: 'access.denied' };
  const NOT_FOUND = { code: 'storefront.slide-not-found' };

  const body = (overrides: object = {}) => ({
    internalName: `Eid ${code}`,
    content: { title: 'Eid Mubarak', body: 'Fresh dates and sweets', textPosition: 'center' },
    startsAt: T0.toString(),
    endsAt: T0.add({ hours: 24 * 30 }).toString(),
    placements: [{ position: 'home.hero', sortOrder: 1, autoplay: true }],
    ...overrides,
  });
  const create = (context: CallContext = editor, kind = 'announcement', extra = {}) =>
    run(CreateStorefrontSlide, context, { kind, ...body(extra) });
  const made = (context: CallContext = editor, kind = 'announcement', extra = {}) =>
    value<SlideDetailView>(create(context, kind, extra));

  describe('create', () => {
    it('creates a draft with its first version and audits it', async () => {
      const slide = await made();
      expect(slide).toMatchObject({
        kind: 'announcement',
        status: 'draft',
        hasDraft: true,
        pending: false,
        positions: ['home.hero'],
        live: null,
        draft: {
          versionNo: 1,
          content: { title: 'Eid Mubarak', textPosition: 'center', textTone: 'light', link: null },
        },
      });
      expect(audit.entries.map((e) => [e.action, e.targetId])).toEqual([
        ['storefront.slide.create', slide.id],
      ]);
      expect(slides.placements).toEqual([]);
    });

    it('creates each kind; a link slide needs its typed link', async () => {
      expect((await made(editor, 'promotion')).kind).toBe('promotion');
      expect(await errorOf(create(editor, 'link'))).toMatchObject({
        code: 'validation.failed',
        fields: [{ path: 'content.link', code: 'required' }],
      });
      const link = { type: 'category', id: CATEGORY };
      const slide = await made(editor, 'link', { content: { title: 'Dates', link } });
      expect(slide.draft?.content?.link).toEqual(link);
    });

    it('refuses a bad body with the problems, a window over 90 days and an unknown kind', async () => {
      expect(
        await errorOf(
          create(editor, 'announcement', { endsAt: T0.add({ hours: 24 * 91 }).toString() }),
        ),
      ).toEqual({
        code: 'validation.failed',
        fields: [{ path: 'endsAt', code: 'too-long' }],
      });
      expect(await errorOf(create(editor, 'banner'))).toMatchObject({ code: 'validation.failed' });
      expect(
        await errorOf(create(editor, 'announcement', { content: { title: 'x', body: '<b>' } })),
      ).toMatchObject({ fields: [{ path: 'content.body', code: 'markup' }] });
      expect(audit.entries).toEqual([]);
    });

    it('is refused without storefront.slide.edit, for a buyer and for a seller account', async () => {
      expect(await errorOf(create(reader))).toEqual(DENIED);
      expect(await errorOf(create(buyer))).toMatchObject({ code: 'access.unauthenticated' });
      expect(await errorOf(create(seller))).toEqual(DENIED);
      expect(slides.slides.size).toBe(0);
    });
  });

  describe('view and list', () => {
    it('shows a slide to a reader, and lists the Market newest first', async () => {
      const first = await made();
      const second = await made(editor, 'promotion', {
        placements: [{ position: 'home.mid' }],
      });
      const seen = await value<SlideDetailView>(
        run(ViewStorefrontSlide, reader, { slide: first.id }),
      );
      expect(seen.id).toBe(first.id);
      const list = await value<SlideSummaryView[]>(run(ListStorefrontSlides, reader, {}));
      expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    });

    it('filters by status and by position, and refuses an unknown filter', async () => {
      const hero = await made();
      const mid = await made(editor, 'announcement', { placements: [{ position: 'home.mid' }] });
      const ids = async (input: object) =>
        (await value<SlideSummaryView[]>(run(ListStorefrontSlides, reader, input))).map(
          (s) => s.id,
        );
      expect(await ids({ position: 'home.mid' })).toEqual([mid.id]);
      expect(await ids({ position: 'home.hero' })).toEqual([hero.id]);
      expect(await ids({ state: 'draft' })).toEqual([mid.id, hero.id]);
      expect(await ids({ state: 'live' })).toEqual([]);
      await value(run(ArchiveStorefrontSlide, editor, { slide: mid.id }));
      expect(await ids({ state: 'archived' })).toEqual([mid.id]);
      expect(await errorOf(run(ListStorefrontSlides, reader, { state: 'sleeping' }))).toMatchObject(
        {
          fields: [{ path: 'state', code: 'enum' }],
        },
      );
      expect(
        await errorOf(run(ListStorefrontSlides, reader, { position: 'checkout.top' })),
      ).toMatchObject({
        fields: [{ path: 'position', code: 'enum' }],
      });
    });

    it('is refused without storefront.slide.read, for a buyer and for a seller account', async () => {
      const slide = await made();
      const nobody = actorIn(market, id<'Account'>(0x99));
      for (const context of [nobody, buyer, seller]) {
        expect(
          await errorOf(run(ViewStorefrontSlide, context, { slide: slide.id })),
        ).toHaveProperty('code');
        expect(await errorOf(run(ListStorefrontSlides, context, {}))).toHaveProperty('code');
        expect(
          await errorOf(run(PrepareStorefrontSlideCopy, context, { slide: slide.id })),
        ).toHaveProperty('code');
      }
      expect(await errorOf(run(ViewStorefrontSlide, nobody, { slide: slide.id }))).toEqual(DENIED);
      expect(await errorOf(run(ViewStorefrontSlide, seller, { slide: slide.id }))).toEqual(DENIED);
    });
  });

  describe('update, restore and archive', () => {
    it('saves every change as a new version and keeps the earlier ones', async () => {
      const slide = await made();
      const changed = await value<SlideDetailView>(
        run(UpdateStorefrontSlideDraft, editor, {
          slide: slide.id,
          body: body({ internalName: 'Eid v2', content: { title: 'Eid Sale' } }),
        }),
      );
      expect(changed).toMatchObject({
        internalName: 'Eid v2',
        draft: { versionNo: 2, content: { title: 'Eid Sale' } },
      });
      expect(changed.versions.map((v) => v.versionNo)).toEqual([2, 1]);
      expect(slides.versionRows.size).toBe(2);
      expect(audit.entries.map((e) => e.action)).toEqual([
        'storefront.slide.create',
        'storefront.slide.draft-change',
      ]);
      expect(slides.locks).toContain(slide.id);
    });

    it('refuses a bad update and an unknown field, leaving the draft as it was', async () => {
      const slide = await made();
      const update = (patch: object) =>
        run(UpdateStorefrontSlideDraft, editor, { slide: slide.id, body: body(patch) });
      expect(
        await errorOf(update({ placements: [{ position: 'home.mid', autoplay: true }] })),
      ).toMatchObject({
        fields: [{ path: 'placements[0].autoplay', code: 'not-allowed-here' }],
      });
      expect(await errorOf(update({ kind: 'link' }))).toMatchObject({
        fields: [{ path: 'kind', code: 'unknown-field' }],
      });
      expect(slides.versionRows.size).toBe(1);
    });

    it('refuses the 101st version of a slide', async () => {
      const slide = await made();
      for (let n = 2; n <= 100; n += 1) {
        await value(run(UpdateStorefrontSlideDraft, editor, { slide: slide.id, body: body() }));
      }
      expect(
        await errorOf(run(UpdateStorefrontSlideDraft, editor, { slide: slide.id, body: body() })),
      ).toEqual({
        code: 'storefront.slide-version-limit',
      });
    });

    it('restores an earlier version as a new draft version, the old one untouched', async () => {
      const slide = await made();
      const v1 = slide.versions[0]!.id;
      await value(
        run(UpdateStorefrontSlideDraft, editor, {
          slide: slide.id,
          body: body({ content: { title: 'Changed' } }),
        }),
      );
      const restored = await value<SlideDetailView>(
        run(RestoreStorefrontSlideVersion, editor, { slide: slide.id, versionId: v1 }),
      );
      expect(restored.draft).toMatchObject({ versionNo: 3, content: { title: 'Eid Mubarak' } });
      expect(slides.versionRows.get(v1)!.content).toMatchObject({ title: 'Eid Mubarak' });
      expect(audit.entries.at(-1)).toMatchObject({ action: 'storefront.slide.draft-change' });
      expect(
        await errorOf(
          run(RestoreStorefrontSlideVersion, editor, { slide: slide.id, versionId: id(0xdead) }),
        ),
      ).toEqual({ code: 'storefront.slide-version-not-found' });
      expect(
        await errorOf(
          run(RestoreStorefrontSlideVersion, editor, { slide: slide.id, versionId: 'nope' }),
        ),
      ).toMatchObject({ code: 'validation.failed' });
    });

    it('archives a slide: it takes no further change and is listed as archived', async () => {
      const slide = await made();
      const archived = await value<SlideDetailView>(
        run(ArchiveStorefrontSlide, editor, { slide: slide.id }),
      );
      expect(archived).toMatchObject({ status: 'archived', hasDraft: false });
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'storefront.slide.archive',
        after: { wasApproved: false },
      });
      for (const [type, input] of [
        [UpdateStorefrontSlideDraft, { slide: slide.id, body: body() }],
        [RestoreStorefrontSlideVersion, { slide: slide.id, versionId: slide.versions[0]!.id }],
        [ArchiveStorefrontSlide, { slide: slide.id }],
      ] as const) {
        expect(await errorOf(run(type, editor, input))).toEqual({
          code: 'storefront.slide-archived',
        });
      }
    });

    it('is refused without storefront.slide.edit', async () => {
      const slide = await made();
      for (const [type, input] of [
        [UpdateStorefrontSlideDraft, { slide: slide.id, body: body() }],
        [RestoreStorefrontSlideVersion, { slide: slide.id, versionId: slide.versions[0]!.id }],
        [ArchiveStorefrontSlide, { slide: slide.id }],
      ] as const) {
        expect(await errorOf(run(type, reader, input))).toEqual(DENIED);
        expect(await errorOf(run(type, buyer, input))).toMatchObject({
          code: 'access.unauthenticated',
        });
        expect(await errorOf(run(type, seller, input))).toEqual(DENIED);
      }
      expect(slides.versionRows.size).toBe(1);
      expect(audit.entries).toHaveLength(1);
    });
  });

  describe('the Market of a slide', () => {
    it('never finds a slide of the other Market, for any use case', async () => {
      const theirs = await made(otherEditor);
      const mine = await made();
      expect(theirs.id).not.toBe(mine.id);
      const inputs: [Runnable, CallContext, object][] = [
        [ViewStorefrontSlide, editor, { slide: theirs.id }],
        [UpdateStorefrontSlideDraft, editor, { slide: theirs.id, body: body() }],
        [
          RestoreStorefrontSlideVersion,
          editor,
          { slide: theirs.id, versionId: theirs.versions[0]!.id },
        ],
        [ArchiveStorefrontSlide, editor, { slide: theirs.id }],
        [PrepareStorefrontSlideCopy, editor, { slide: theirs.id }],
        // And the other way round.
        [ViewStorefrontSlide, otherEditor, { slide: mine.id }],
        [ArchiveStorefrontSlide, otherEditor, { slide: mine.id }],
      ];
      for (const [type, context, input] of inputs) {
        expect(await errorOf(run(type, context, input))).toEqual(NOT_FOUND);
      }
      expect(
        (await value<SlideDetailView>(run(ViewStorefrontSlide, otherReader, { slide: theirs.id })))
          .status,
      ).toBe('draft');
      expect(slides.slides.get(theirs.id)!.state).toBe('draft');
      expect(slides.versionRows.size).toBe(2);
    });

    it('lists only the slides of the request Market', async () => {
      const mine = await made();
      await made(otherEditor);
      await made(otherEditor);
      const list = await value<SlideSummaryView[]>(run(ListStorefrontSlides, reader, {}));
      expect(list.map((s) => s.id)).toEqual([mine.id]);
      expect(
        await value<SlideSummaryView[]>(run(ListStorefrontSlides, otherReader, {})),
      ).toHaveLength(2);
    });

    it('cannot even build a call context that crosses the Markets', () => {
      expect(() => testCallContext(otherMarket, editor.actor)).toThrow('market-mismatch');
    });
  });

  describe('copy to another Market', () => {
    it('hands out a package that an editor of the other Market creates a draft from', async () => {
      const link = { type: 'category', id: CATEGORY };
      const source = await made(editor, 'promotion', {
        content: { title: 'Dates', link, image: { ref: 'dates', alt: 'Dates' } },
        placements: [
          {
            position: 'category.top',
            scope: 'category',
            scopeId: CATEGORY,
            includeSubcategories: true,
          },
          { position: 'home.hero', autoplay: true },
        ],
        pinned: true,
      });
      const pack = await value<SlideCopyPackage>(
        run(PrepareStorefrontSlideCopy, reader, { slide: source.id }),
      );
      expect(pack).toMatchObject({
        kind: 'promotion',
        pinned: true,
        content: { title: 'Dates', link },
        placements: [
          { position: 'category.top', scope: 'all', scopeId: null, includeSubcategories: false },
          { position: 'home.hero', scope: 'all', autoplay: true },
        ],
      });
      // The other Market's editor needs its own storefront.slide.edit; a reader there cannot.
      const { kind, ...rest } = pack;
      const input = { kind, ...rest };
      expect(await errorOf(run(CreateStorefrontSlide, otherReader, input))).toEqual(DENIED);
      const copy = await value<SlideDetailView>(run(CreateStorefrontSlide, otherEditor, input));
      expect(copy).toMatchObject({
        kind: 'promotion',
        status: 'draft',
        internalName: source.internalName,
      });
      expect(slides.slides.get(copy.id)!.marketId).toBe(otherMarket.marketId);
      expect(slides.slides.get(source.id)!.marketId).toBe(market.marketId);
      expect(
        (await value<SlideSummaryView[]>(run(ListStorefrontSlides, reader, {}))).map((s) => s.id),
      ).toEqual([source.id]);
    });
  });
});
