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
import {
  STOREFRONT_SLIDE_EDIT,
  STOREFRONT_SLIDE_PAUSE,
  STOREFRONT_SLIDE_PUBLISH,
  STOREFRONT_SLIDE_READ,
} from '../contracts/permissions';
import { STOREFRONT_AUDIT_ACTIONS } from '../domain/audit';
import type { SlideCopyPackage, SlideDetailView, SlideSummaryView } from './slide-flow';
import type { StorefrontDependencies } from './storefront-dependencies';
import { ApproveStorefrontSlide } from './use-cases/approve-slide.use-case';
import { ArchiveStorefrontSlide } from './use-cases/archive-slide.use-case';
import { CreateStorefrontSlide } from './use-cases/create-slide.use-case';
import { ListStorefrontSlides } from './use-cases/list-slides.use-case';
import { PrepareStorefrontSlideCopy } from './use-cases/prepare-slide-copy.use-case';
import { PauseStorefrontSlide } from './use-cases/pause-slide.use-case';
import { ResumeStorefrontSlide } from './use-cases/resume-slide.use-case';
import { SubmitStorefrontSlide } from './use-cases/submit-slide.use-case';
import { RestoreStorefrontSlideVersion } from './use-cases/restore-slide-version.use-case';
import { UpdateStorefrontSlideDraft } from './use-cases/update-slide-draft.use-case';
import { ViewStorefrontSlide } from './use-cases/view-slide.use-case';

// The slide library use cases in memory on both Market fixtures, behind a gate that grants each
// actor only its own keys: a reader sees slides; an editor also creates, changes, restores,
// copies out, archives and submits for approval; a pauser (an editor with the pause key) stops a
// live slide; only the platform admin approves and resumes. Every slide belongs to one Market, and one Market never finds another's.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-23T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const READER = id<'Account'>(0x5e);
const EDITOR = id<'Account'>(0xed);
const PAUSER = id<'Account'>(0xfa);
const ADMIN = id<'Account'>(0xad);
const CATEGORY = id<'Category'>(0xca).toString();
const ACTIONS = new Set<string>(STOREFRONT_AUDIT_ACTIONS.map((a) => a.action));
const KEYS = new Map<string, string[]>([
  [READER, [STOREFRONT_SLIDE_READ.key]],
  [EDITOR, [STOREFRONT_SLIDE_READ.key, STOREFRONT_SLIDE_EDIT.key]],
  [PAUSER, [STOREFRONT_SLIDE_READ.key, STOREFRONT_SLIDE_PAUSE.key]],
  [
    ADMIN,
    [
      STOREFRONT_SLIDE_READ.key,
      STOREFRONT_SLIDE_EDIT.key,
      STOREFRONT_SLIDE_PAUSE.key,
      STOREFRONT_SLIDE_PUBLISH.key,
    ],
  ],
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
  const pauser = actorIn(market, PAUSER);
  const admin = actorIn(market, ADMIN);
  const otherEditor = actorIn(otherMarket, EDITOR);
  const otherAdmin = actorIn(otherMarket, ADMIN);
  const otherReader = actorIn(otherMarket, READER);
  const buyer = testCallContext(market, 'anonymous');
  const seller = actorIn(market, EDITOR, 'seller');

  let slides: MemorySlides;
  let audit: RecordingAudit;
  let deps: StorefrontDependencies;
  beforeEach(() => {
    clock.set(T0);
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

  describe('submit, approve, pause and resume', () => {
    const submit = (context: CallContext, slide: string) =>
      run(SubmitStorefrontSlide, context, { slide });
    const approve = (context: CallContext, slide: string, versionNo = 1) =>
      run(ApproveStorefrontSlide, context, { slide, body: { versionNo } });
    const pause = (context: CallContext, slide: string) =>
      run(PauseStorefrontSlide, context, { slide });
    const resume = (context: CallContext, slide: string) =>
      run(ResumeStorefrontSlide, context, { slide });
    const view = (slide: string, context: CallContext = admin) =>
      value<SlideDetailView>(run(ViewStorefrontSlide, context, { slide }));
    /** A slide at `position`, drafted by the editor, submitted and approved by the admin. */
    const live = async (
      position = 'home.hero',
      window: { startsAt?: string; endsAt?: string } = {},
      context: CallContext = editor,
      approver: CallContext = admin,
    ) => {
      const slide = await made(context, 'announcement', {
        placements: [{ position }],
        ...window,
      });
      await value(submit(context, slide.id));
      return value<SlideDetailView>(approve(approver, slide.id));
    };
    const placedPositions = (slideId: string) =>
      slides.placements.filter((p) => p.slideId === slideId).map((p) => p.position);

    it('lets an editor submit, but only a platform admin approve and publish', async () => {
      const slide = await made();
      expect(await errorOf(approve(admin, slide.id))).toEqual({
        code: 'storefront.slide-not-submitted',
      });
      const pending = await value<SlideDetailView>(submit(editor, slide.id));
      expect(pending).toMatchObject({ status: 'pending', pending: true });
      expect(await errorOf(approve(editor, slide.id))).toEqual(DENIED);
      expect(await errorOf(approve(pauser, slide.id))).toEqual(DENIED);
      expect(slides.placements).toEqual([]);

      const done = await value<SlideDetailView>(approve(admin, slide.id));
      expect(done).toMatchObject({
        status: 'live',
        hasDraft: false,
        pending: false,
        draft: null,
        live: { versionNo: 1, approvedAt: T0 },
      });
      const version = slides.versionRows.get(done.live!.id)!;
      expect(version.approvedBy).toBe(ADMIN);
      expect(version.approvedAt).toEqual(T0);
      expect(slides.placements).toMatchObject([
        { slideId: slide.id, position: 'home.hero', autoplay: true, sortOrder: 1 },
      ]);
      expect(audit.entries.map((e) => e.action)).toEqual([
        'storefront.slide.create',
        'storefront.slide.submit',
        'storefront.slide.publish',
      ]);
      expect(slides.locks).toContain('home.hero');
    });

    it('derives scheduled, live and ended from the clock and the window', async () => {
      const start = T0.add({ hours: 10 });
      const slide = await live('home.hero', {
        startsAt: start.toString(),
        endsAt: start.add({ hours: 5 }).toString(),
      });
      expect(slide.status).toBe('scheduled');
      clock.set(start);
      expect((await view(slide.id)).status).toBe('live');
      clock.set(start.add({ hours: 5 }));
      expect((await view(slide.id)).status).toBe('ended');
      const list = await value<SlideSummaryView[]>(
        run(ListStorefrontSlides, reader, { state: 'ended' }),
      );
      expect(list.map((s) => s.id)).toEqual([slide.id]);
    });

    it('checks what the admin reviewed: the draft version, a submission, an open window', async () => {
      const slide = await made();
      await value(submit(editor, slide.id));
      expect(await errorOf(approve(admin, slide.id, 2))).toEqual({
        code: 'storefront.slide-draft-changed',
      });
      expect(
        await errorOf(run(ApproveStorefrontSlide, admin, { slide: slide.id, body: {} })),
      ).toMatchObject({
        fields: [{ path: 'versionNo', code: 'required' }],
      });
      // Changing the draft after submitting withdraws the submission.
      await value(run(UpdateStorefrontSlideDraft, editor, { slide: slide.id, body: body() }));
      expect((await view(slide.id)).status).toBe('draft');
      expect(await errorOf(approve(admin, slide.id, 2))).toEqual({
        code: 'storefront.slide-not-submitted',
      });
      expect(await errorOf(approve(admin, slide.id, 1))).toEqual({
        code: 'storefront.slide-draft-changed',
      });
      // A window that has ended is neither submitted nor approved.
      await value(submit(editor, slide.id));
      clock.set(T0.add({ hours: 24 * 31 }));
      expect(await errorOf(submit(editor, slide.id))).toEqual({ code: 'storefront.slide-ended' });
      expect(await errorOf(approve(admin, slide.id, 2))).toEqual({
        code: 'storefront.slide-ended',
      });
      expect(slides.placements).toEqual([]);
    });

    it('refuses to submit with no draft, and a slide that is archived', async () => {
      const slide = await live();
      expect(await errorOf(submit(editor, slide.id))).toEqual({
        code: 'storefront.slide-no-draft',
      });
      await value(run(ArchiveStorefrontSlide, editor, { slide: slide.id }));
      expect(await errorOf(submit(editor, slide.id))).toEqual({
        code: 'storefront.slide-archived',
      });
      expect(await errorOf(approve(admin, slide.id))).toEqual({
        code: 'storefront.slide-archived',
      });
      expect(await errorOf(pause(pauser, slide.id))).toEqual({ code: 'storefront.slide-archived' });
      expect(await errorOf(resume(admin, slide.id))).toEqual({ code: 'storefront.slide-archived' });
      // Archiving a live slide takes it off the buyer site at once.
      expect(slides.placements).toEqual([]);
      expect(audit.entries.at(-1)).toMatchObject({ after: { wasApproved: true } });
    });

    it('lets a new version replace the live one only when approved; the live one keeps serving', async () => {
      const slide = await live();
      const v1 = slide.live!.id;
      await value(
        run(UpdateStorefrontSlideDraft, editor, {
          slide: slide.id,
          body: body({ content: { title: 'Eid Sale' }, placements: [{ position: 'home.mid' }] }),
        }),
      );
      expect(await view(slide.id)).toMatchObject({
        status: 'live',
        hasDraft: true,
        draft: { versionNo: 2 },
        live: { versionNo: 1, content: { title: 'Eid Mubarak' } },
      });
      expect(placedPositions(slide.id)).toEqual(['home.hero']);
      await value(submit(editor, slide.id));
      await value(approve(admin, slide.id, 2));
      expect(await view(slide.id)).toMatchObject({
        live: { versionNo: 2, content: { title: 'Eid Sale' } },
        draft: null,
      });
      expect(placedPositions(slide.id)).toEqual(['home.mid']);
      expect(slides.versionRows.get(v1)!.content).toMatchObject({ title: 'Eid Mubarak' });
      // The earlier approved version can come back as a draft and be approved again.
      await value(run(RestoreStorefrontSlideVersion, editor, { slide: slide.id, versionId: v1 }));
      await value(submit(editor, slide.id));
      await value(approve(admin, slide.id, 3));
      expect(placedPositions(slide.id)).toEqual(['home.hero']);
      expect(slides.versionRows.get(v1)!.approvedAt).toEqual(T0);
    });

    it('lets an editor with the pause key stop a live slide at once, without approval', async () => {
      const slide = await live();
      expect(await errorOf(pause(editor, slide.id))).toEqual(DENIED);
      expect(await errorOf(pause(reader, slide.id))).toEqual(DENIED);
      expect(await errorOf(pause(buyer, slide.id))).toMatchObject({
        code: 'access.unauthenticated',
      });
      expect(await errorOf(pause(seller, slide.id))).toEqual(DENIED);
      const paused = await value<SlideDetailView>(pause(pauser, slide.id));
      expect(paused.status).toBe('paused');
      expect(placedPositions(slide.id)).toEqual([]);
      expect(audit.entries.at(-1)).toMatchObject({ action: 'storefront.slide.pause' });
      // Not live any more, so a second pause finds nothing to stop.
      expect(await errorOf(pause(pauser, slide.id))).toEqual({ code: 'storefront.slide-not-live' });
    });

    it('cannot pause a draft, a slide that has ended or one that is archived', async () => {
      const draft = await made();
      expect(await errorOf(pause(pauser, draft.id))).toEqual({ code: 'storefront.slide-not-live' });
      const slide = await live();
      clock.set(T0.add({ hours: 24 * 30 }));
      expect(await errorOf(pause(pauser, slide.id))).toEqual({ code: 'storefront.slide-not-live' });
    });

    it('needs the publish key to resume: a pauser cannot, an editor cannot, the admin can', async () => {
      const slide = await live();
      await value(pause(pauser, slide.id));
      expect(await errorOf(resume(pauser, slide.id))).toEqual(DENIED);
      expect(await errorOf(resume(editor, slide.id))).toEqual(DENIED);
      expect(await errorOf(resume(reader, slide.id))).toEqual(DENIED);
      expect(placedPositions(slide.id)).toEqual([]);
      const resumed = await value<SlideDetailView>(resume(admin, slide.id));
      expect(resumed.status).toBe('live');
      expect(placedPositions(slide.id)).toEqual(['home.hero']);
      expect(audit.entries.map((e) => e.action).slice(-2)).toEqual([
        'storefront.slide.pause',
        'storefront.slide.resume',
      ]);
      expect(await errorOf(resume(admin, slide.id))).toEqual({
        code: 'storefront.slide-not-paused',
      });
      // A paused slide whose window ended cannot be resumed.
      await value(pause(pauser, slide.id));
      clock.set(T0.add({ hours: 24 * 31 }));
      expect(await errorOf(resume(admin, slide.id))).toEqual({ code: 'storefront.slide-ended' });
    });

    it('keeps a paused slide paused when a new version is approved; resuming serves it', async () => {
      const slide = await live();
      await value(pause(pauser, slide.id));
      await value(
        run(UpdateStorefrontSlideDraft, editor, {
          slide: slide.id,
          body: body({ placements: [{ position: 'home.mid' }] }),
        }),
      );
      await value(submit(editor, slide.id));
      expect((await value<SlideDetailView>(approve(admin, slide.id, 2))).status).toBe('paused');
      expect(placedPositions(slide.id)).toEqual([]);
      await value(resume(admin, slide.id));
      expect(placedPositions(slide.id)).toEqual(['home.mid']);
    });

    describe('the maximum of active slides in a position', () => {
      it('refuses the approval that would exceed the position, then admits it when room appears', async () => {
        const first = await live('home.mid');
        for (let n = 1; n < 4; n += 1) await live('home.mid');
        const over = await made(editor, 'announcement', { placements: [{ position: 'home.mid' }] });
        await value(submit(editor, over.id));
        expect(await errorOf(approve(admin, over.id))).toEqual({
          code: 'storefront.slide-position-full',
          fields: [{ path: 'placements[0].position', code: 'full' }],
        });
        expect(placedPositions(over.id)).toEqual([]);
        expect((await view(over.id)).status).toBe('pending');
        // Another position is not full.
        const other = await live('category.top');
        expect(other.status).toBe('live');
        await value(pause(pauser, first.id));
        expect((await value<SlideDetailView>(approve(admin, over.id))).status).toBe('live');
        // Resuming the paused one would now be the fifth.
        expect(await errorOf(resume(admin, first.id))).toMatchObject({
          code: 'storefront.slide-position-full',
        });
        expect((await view(first.id)).status).toBe('paused');
      });

      it('holds the maximums: hero 8, mid 4, category 4, product 3, cart 3, landing 8', async () => {
        for (const [position, max] of [
          ['home.hero', 8],
          ['home.mid', 4],
          ['category.top', 4],
          ['product.below-details', 3],
          ['cart.below-lines', 3],
          ['landing.top', 8],
        ] as const) {
          for (let n = 0; n < max; n += 1) await live(position);
          const over = await made(editor, 'announcement', { placements: [{ position }] });
          await value(submit(editor, over.id));
          expect(await errorOf(approve(admin, over.id))).toMatchObject({
            code: 'storefront.slide-position-full',
          });
        }
      });

      it('counts only overlapping windows', async () => {
        const day = (n: number) => T0.add({ hours: 24 * n }).toString();
        for (let n = 0; n < 4; n += 1)
          await live('home.mid', { startsAt: day(0), endsAt: day(10) });
        const later = await live('home.mid', { startsAt: day(10), endsAt: day(20) });
        expect(later.status).toBe('scheduled');
        const overlapping = await made(editor, 'announcement', {
          placements: [{ position: 'home.mid' }],
          startsAt: day(9),
          endsAt: day(12),
        });
        await value(submit(editor, overlapping.id));
        expect(await errorOf(approve(admin, overlapping.id))).toMatchObject({
          code: 'storefront.slide-position-full',
        });
      });

      it('counts a scoped placement only against placements that can show on the same page', async () => {
        const cat = (scopeId: string) => ({
          placements: [{ position: 'category.top', scope: 'category', scopeId }],
        });
        const slideIn = async (scopeId: string) => {
          const slide = await made(editor, 'announcement', cat(scopeId));
          await value(submit(editor, slide.id));
          return slide;
        };
        const a = id<'Category'>(0xca1).toString();
        const b = id<'Category'>(0xca2).toString();
        for (let n = 0; n < 4; n += 1) await value(approve(admin, (await slideIn(a)).id));
        // Category b has its own room; one more for category a does not fit.
        expect((await value<SlideDetailView>(approve(admin, (await slideIn(b)).id))).status).toBe(
          'live',
        );
        expect(await errorOf(approve(admin, (await slideIn(a)).id))).toMatchObject({
          code: 'storefront.slide-position-full',
        });
      });

      it('counts per Market: a full position in one Market leaves the other open', async () => {
        for (let n = 0; n < 4; n += 1) await live('home.mid');
        const theirs = await live('home.mid', {}, otherEditor, otherAdmin);
        expect(theirs.status).toBe('live');
        expect(slides.slides.get(theirs.id)!.marketId).toBe(otherMarket.marketId);
      });
    });

    it('never finds a slide of the other Market to submit, approve, pause or resume', async () => {
      const theirs = await live('home.hero', {}, otherEditor, otherAdmin);
      await value(pause(actorIn(otherMarket, ADMIN), theirs.id));
      const mine = await made();
      await value(submit(editor, mine.id));
      for (const [type, context, input] of [
        [SubmitStorefrontSlide, editor, { slide: theirs.id }],
        [ApproveStorefrontSlide, admin, { slide: theirs.id, body: { versionNo: 1 } }],
        [PauseStorefrontSlide, pauser, { slide: theirs.id }],
        [ResumeStorefrontSlide, admin, { slide: theirs.id }],
        [ApproveStorefrontSlide, otherAdmin, { slide: mine.id, body: { versionNo: 1 } }],
        [SubmitStorefrontSlide, otherEditor, { slide: mine.id }],
      ] as const) {
        expect(await errorOf(run(type, context, input))).toEqual(NOT_FOUND);
      }
      expect(slides.slides.get(theirs.id)!.state).toBe('paused');
      expect(slides.slides.get(mine.id)!.state).toBe('draft');
    });

    it('is refused for a buyer and a seller account, on every approval use case', async () => {
      const slide = await made();
      for (const context of [buyer, seller]) {
        for (const [type, input] of [
          [SubmitStorefrontSlide, { slide: slide.id }],
          [ApproveStorefrontSlide, { slide: slide.id, body: { versionNo: 1 } }],
          [PauseStorefrontSlide, { slide: slide.id }],
          [ResumeStorefrontSlide, { slide: slide.id }],
        ] as const) {
          expect(await errorOf(run(type, context, input))).toHaveProperty('code');
        }
      }
      expect(await errorOf(submit(reader, slide.id))).toEqual(DENIED);
      expect(await errorOf(submit(pauser, slide.id))).toEqual(DENIED);
      expect(audit.entries).toHaveLength(1);
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
