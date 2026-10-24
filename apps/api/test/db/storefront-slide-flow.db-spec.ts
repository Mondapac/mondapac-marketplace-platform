import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import {
  approveSlide,
  pauseSlide,
  resumeSlide,
  submitSlide,
} from '../../src/modules/storefront/application/slide-approval-flow';
import {
  archiveSlide,
  createSlide,
  updateSlideDraft,
  viewSlide,
} from '../../src/modules/storefront/application/slide-flow';
import { reorderLiveSlides } from '../../src/modules/storefront/application/slide-order-flow';
import { targetKey } from '../../src/modules/storefront/application/ports/slide-targets';
import type { StorefrontDependencies } from '../../src/modules/storefront/application/storefront-dependencies';
import { PrismaSlideRepository } from '../../src/modules/storefront/infrastructure/prisma-slide.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The slide flows against the real tables as the application role, in both Market fixtures: a
// draft is submitted and approved (the approver is stamped on the insert-only version, the live
// projection is written), a position refuses the slide over its maximum, pausing removes the
// projection at once, resuming rebuilds it, and one Market never sees or fills another's.

const T0 = Temporal.Instant.from('2026-10-23T00:00:00Z');
const POSITION = 'cart.below-lines';
/** A position the other tests leave room in. */
const PUBLIC_POSITION = 'landing.top';

describe.each(TEST_MARKETS)('storefront slide flows in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  // Each Market fixture's run uses its own stretch of time: both share one database, and the
  // other Market's slides of the first run are still there when the second one starts.
  const base = TEST_MARKETS.indexOf(code) * 24 * 400;
  const start = T0.add({ hours: base });
  const clock = new FixedClock(start);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let deps: StorefrontDependencies;
  let slides: PrismaSlideRepository;
  const recorded: string[] = [];

  const actor = (target: typeof market): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      `slide-db-${target.marketId.toLowerCase()}-0001`,
    );
  const context = actor(market);
  const otherContext = actor(other);

  beforeAll(() => {
    db = createPersistence();
    slides = new PrismaSlideRepository(db.service);
    deps = {
      unitOfWork: db.unitOfWork,
      pages: undefined as never,
      // Facades are covered by their own specs; here every target is live.
      targets: { live: (_c, targets) => Promise.resolve(new Set(targets.map(targetKey))) },
      slides,
      links: undefined as never,
      audit: {
        record: (_c, entry) => {
          recorded.push(entry.action);
          return Promise.resolve();
        },
      },
      ids,
      clock,
    };
  });
  afterAll(async () => {
    await db.close();
  });

  const draft = (offset = 0, extra: object = {}) => {
    const hours = base + offset;
    return {
      kind: 'announcement',
      internalName: 'Cart nudge',
      content: { title: 'Free delivery over $80', textTone: 'dark' },
      startsAt: T0.add({ hours }).toString(),
      endsAt: T0.add({ hours: hours + 48 }).toString(),
      placements: [{ position: POSITION }],
      ...extra,
    };
  };
  const ok = <T>(result: { ok: boolean } & ({ value: T } | { error: unknown })): T => {
    if (!result.ok)
      throw new Error(`refused: ${JSON.stringify((result as { error: unknown }).error)}`);
    return (result as { value: T }).value;
  };
  const approved = async (target: CallContext, hours = 0, position = POSITION) => {
    const created = ok(
      await createSlide(deps, target, draft(hours, { placements: [{ position }] })),
    );
    ok(await submitSlide(deps, target, { slide: created.id }));
    return ok(await approveSlide(deps, target, { slide: created.id, body: { versionNo: 1 } }));
  };
  const projected = (target: typeof market, slideId: Id<'StorefrontSlide'>) =>
    db.unitOfWork
      .run(target, async () => ({
        ok: true as const,
        value: await slides.placementsOf(target, slideId),
      }))
      .then((r) => (r.ok ? r.value : []));

  it('approves a submitted draft: the live version is stamped and the slide is projected', async () => {
    const created = ok(await createSlide(deps, context, draft()));
    expect(created.status).toBe('draft');
    ok(await submitSlide(deps, context, { slide: created.id }));
    const done = ok(
      await approveSlide(deps, context, { slide: created.id, body: { versionNo: 1 } }),
    );
    expect(done).toMatchObject({
      status: 'live',
      draft: null,
      live: { versionNo: 1, content: { title: 'Free delivery over $80', textTone: 'dark' } },
    });
    expect(done.live?.approvedAt?.toString()).toBe(start.toString());
    expect((await projected(market, created.id)).map((p) => p.position)).toEqual([POSITION]);
    expect(await projected(other, created.id)).toEqual([]);
    expect(recorded.slice(-3)).toEqual([
      'storefront.slide.create',
      'storefront.slide.submit',
      'storefront.slide.publish',
    ]);
    // A slide of this Market is not found from the other.
    const crossed = await viewSlide(deps, otherContext, { slide: created.id });
    expect(crossed).toEqual({ ok: false, error: { code: 'storefront.slide-not-found' } });
  });

  it('refuses the slide over the position maximum (3), and counts per Market', async () => {
    const day = 24 * 10;
    for (let n = 0; n < 3; n += 1) await approved(context, day);
    const over = ok(await createSlide(deps, context, draft(day)));
    ok(await submitSlide(deps, context, { slide: over.id }));
    const refused = await approveSlide(deps, context, { slide: over.id, body: { versionNo: 1 } });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'storefront.slide-position-full',
        fields: [{ path: 'placements[0].position', code: 'full' }],
      },
    });
    expect(await projected(market, over.id)).toEqual([]);
    // Another window is free; the other Market has its own room.
    expect((await approved(context, day + 24 * 5)).status).toBe('scheduled');
    expect((await approved(otherContext, day)).status).toBe('scheduled');
  });

  it('pauses at once and resumes with the maximum checked again', async () => {
    const day = 24 * 40;
    const first = await approved(context, day);
    await approved(context, day);
    await approved(context, day);
    const paused = ok(await pauseSlide(deps, context, { slide: first.id }));
    expect(paused.status).toBe('paused');
    expect(await projected(market, first.id)).toEqual([]);
    const fourth = await approved(context, day);
    expect(fourth.status).toBe('scheduled');
    expect(await resumeSlide(deps, context, { slide: first.id })).toMatchObject({
      ok: false,
      error: { code: 'storefront.slide-position-full' },
    });
    ok(await archiveSlide(deps, context, { slide: fourth.id }));
    expect(await projected(market, fourth.id)).toEqual([]);
    const resumed = ok(await resumeSlide(deps, context, { slide: first.id }));
    expect(resumed.status).toBe('scheduled');
    expect((await projected(market, first.id)).map((p) => p.position)).toEqual([POSITION]);
  });

  const FULL = { code: 'storefront.slide-position-full' };
  const winners = (results: readonly { ok: boolean }[]) => results.filter((r) => r.ok).length;

  it('lets exactly one of two parallel approvals take the last place of a position', async () => {
    const day = 24 * 120;
    await approved(context, day);
    await approved(context, day);
    const submit = async () => {
      const created = ok(await createSlide(deps, context, draft(day)));
      ok(await submitSlide(deps, context, { slide: created.id }));
      return created.id;
    };
    const [a, b] = [await submit(), await submit()];
    const results = await Promise.all([
      approveSlide(deps, context, { slide: a, body: { versionNo: 1 } }),
      approveSlide(deps, context, { slide: b, body: { versionNo: 1 } }),
    ]);
    expect(winners(results)).toBe(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false, error: FULL });
    const placed = [...(await projected(market, a)), ...(await projected(market, b))];
    expect(placed).toHaveLength(1);
  });

  it('lets exactly one of an approval and a resume take the last place', async () => {
    const day = 24 * 160;
    const paused = await approved(context, day);
    ok(await pauseSlide(deps, context, { slide: paused.id }));
    await approved(context, day);
    await approved(context, day);
    const created = ok(await createSlide(deps, context, draft(day)));
    ok(await submitSlide(deps, context, { slide: created.id }));
    const results = await Promise.all([
      approveSlide(deps, context, { slide: created.id, body: { versionNo: 1 } }),
      resumeSlide(deps, context, { slide: paused.id }),
    ]);
    expect(winners(results)).toBe(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: FULL });
    const placed = [
      ...(await projected(market, created.id)),
      ...(await projected(market, paused.id)),
    ];
    expect(placed).toHaveLength(1);
  });

  it('keeps every draft save as a version and leaves the live version serving', async () => {
    const live = await approved(context, 24 * 80);
    const replacement: Record<string, unknown> = draft(24 * 80, { internalName: 'Cart nudge v2' });
    delete replacement.kind;
    const updated = ok(
      await updateSlideDraft(deps, context, {
        slide: live.id,
        body: replacement,
      }),
    );
    expect(updated).toMatchObject({
      internalName: 'Cart nudge',
      live: { versionNo: 1 },
      draft: { versionNo: 2, internalName: 'Cart nudge v2' },
    });
    expect(updated.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect((await projected(market, live.id)).map((p) => p.position)).toEqual([POSITION]);
  });

  it('serves only approved slides of the request Market to the public read, and not a paused one', async () => {
    const served = (target: typeof market) =>
      db.unitOfWork
        .run(target, async () => ({
          ok: true as const,
          value: await slides.servedAt(target, PUBLIC_POSITION, start, 100),
        }))
        .then((r) => (r.ok ? r.value : []));
    const live = await approved(context, 24 * 120, PUBLIC_POSITION);
    const theirs = await approved(otherContext, 24 * 120, PUBLIC_POSITION);
    expect((await served(market)).map((p) => p.slideId)).toContain(live.id);
    expect((await served(market)).map((p) => p.slideId)).not.toContain(theirs.id);
    expect((await served(other)).map((p) => p.slideId)).toContain(theirs.id);
    expect((await served(other)).map((p) => p.slideId)).not.toContain(live.id);
    const row = (await served(market)).find((p) => p.slideId === live.id)!;
    expect(row).toMatchObject({ kind: 'announcement', scope: 'all', pinned: false });
    expect(row.liveVersionId).toBe(live.live?.id);
    ok(await pauseSlide(deps, context, { slide: live.id }));
    expect((await served(market)).map((p) => p.slideId)).not.toContain(live.id);
  });

  describe('reordering the live slides', () => {
    // Each case works in a category of its own, so its list of live slides is its own.
    const inCategory = async (target: CallContext, scopeId: string, hours = 24 * 200) => {
      const created = ok(
        await createSlide(
          deps,
          target,
          draft(hours, {
            placements: [{ position: 'category.top', scope: 'category', scopeId }],
          }),
        ),
      );
      ok(await submitSlide(deps, target, { slide: created.id }));
      return ok(await approveSlide(deps, target, { slide: created.id, body: { versionNo: 1 } }));
    };
    const reorder = (target: CallContext, scopeId: string, slideIds: readonly string[]) =>
      reorderLiveSlides(deps, target, {
        position: 'category.top',
        scope: 'category',
        scopeId,
        slideIds,
      });
    const rowsOf = (target: typeof market, scopeId: string) =>
      db.unitOfWork
        .run(target, async () => ({
          ok: true as const,
          value: await slides.livePlacementsAt(
            target,
            { position: 'category.top', scope: 'category', scopeId },
            start,
          ),
        }))
        .then((r) => (r.ok ? r.value : []));
    const orderOf = async (target: typeof market, scopeId: string) =>
      (await rowsOf(target, scopeId)).map((p) => p.slideId as string);
    const saved = (target: typeof market, slideId: Id<'StorefrontSlide'>) =>
      db.unitOfWork
        .run(target, async () => ({
          ok: true as const,
          value: await slides.savedOrdersOf(target, slideId),
        }))
        .then((r) => (r.ok ? r.value : []));
    const category = () => ids.next<'Category'>() as string;

    it('writes the sort order of the live rows and saves it, in this Market only', async () => {
      const scope = category();
      const [a, b, c] = [
        await inCategory(context, scope),
        await inCategory(context, scope),
        await inCategory(context, scope),
      ];
      // The same scope id in the other Market is a list of its own.
      const theirs = await inCategory(otherContext, scope);
      const answer = ok(await reorder(context, scope, [c.id, a.id, b.id]));
      expect(answer.slideIds).toEqual([c.id, a.id, b.id]);
      expect(await orderOf(market, scope)).toEqual([c.id, a.id, b.id]);
      expect((await rowsOf(market, scope)).map((p) => p.sortOrder)).toEqual([0, 1, 2]);
      expect(await saved(market, c.id)).toEqual([
        { position: 'category.top', scope: 'category', scopeId: scope, sortOrder: 0 },
      ]);
      expect(await orderOf(other, scope)).toEqual([theirs.id]);
      expect(await saved(other, theirs.id)).toEqual([]);
      // The other Market's editor cannot name this Market's slides.
      expect(await reorder(otherContext, scope, [theirs.id, a.id])).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'slideIds[1]', code: 'not-found' }] },
      });
      expect(recorded.at(-1)).toBe('storefront.slide.reorder');
    });

    it('refuses a partial list, a paused slide and a slide of another scope, changing nothing', async () => {
      const scope = category();
      const [a, b, c] = [
        await inCategory(context, scope),
        await inCategory(context, scope),
        await inCategory(context, scope),
      ];
      const elsewhere = await inCategory(context, category());
      ok(await pauseSlide(deps, context, { slide: c.id }));
      const was = await orderOf(market, scope);
      expect(was).toHaveLength(2);
      for (const list of [[a.id], [a.id, b.id, c.id], [a.id, b.id, elsewhere.id]]) {
        expect(await reorder(context, scope, list)).toMatchObject({
          ok: false,
          error: { code: 'storefront.slide-order-mismatch' },
        });
      }
      expect(await orderOf(market, scope)).toEqual(was);
      expect(await saved(market, a.id)).toEqual([]);
    });

    it('keeps the saved order through a re-approval, a pause and a resume', async () => {
      const scope = category();
      const [a, b, c] = [
        await inCategory(context, scope),
        await inCategory(context, scope),
        await inCategory(context, scope),
      ];
      ok(await reorder(context, scope, [c.id, a.id, b.id]));
      // A new version of `b` that still says sort order 0.
      const replacement: Record<string, unknown> = draft(24 * 200, {
        internalName: 'Second',
        placements: [{ position: 'category.top', scope: 'category', scopeId: scope, sortOrder: 0 }],
      });
      delete replacement.kind;
      ok(await updateSlideDraft(deps, context, { slide: b.id, body: replacement }));
      ok(await submitSlide(deps, context, { slide: b.id }));
      ok(await approveSlide(deps, context, { slide: b.id, body: { versionNo: 2 } }));
      expect(await orderOf(market, scope)).toEqual([c.id, a.id, b.id]);
      ok(await pauseSlide(deps, context, { slide: c.id }));
      expect(await orderOf(market, scope)).toEqual([a.id, b.id]);
      ok(await resumeSlide(deps, context, { slide: c.id }));
      expect(await orderOf(market, scope)).toEqual([c.id, a.id, b.id]);
      // A version that moves the slide elsewhere forgets the saved order of the old place.
      const moved: Record<string, unknown> = draft(24 * 700, {
        placements: [{ position: 'home.mid' }],
      });
      delete moved.kind;
      ok(await updateSlideDraft(deps, context, { slide: a.id, body: moved }));
      ok(await submitSlide(deps, context, { slide: a.id }));
      ok(await approveSlide(deps, context, { slide: a.id, body: { versionNo: 2 } }));
      expect(await saved(market, a.id)).toEqual([]);
      expect(await orderOf(market, scope)).toEqual([c.id, b.id]);
    });

    it('serializes a reorder with an approval and a resume of a slide at the same list', async () => {
      for (let round = 0; round < 4; round += 1) {
        const scope = category();
        const [a, b] = [await inCategory(context, scope), await inCategory(context, scope)];
        const parked = await inCategory(context, scope);
        ok(await pauseSlide(deps, context, { slide: parked.id }));
        const fresh = ok(
          await createSlide(
            deps,
            context,
            draft(24 * 200, {
              placements: [{ position: 'category.top', scope: 'category', scopeId: scope }],
            }),
          ),
        );
        ok(await submitSlide(deps, context, { slide: fresh.id }));

        const [moved, approvedFresh, resumed] = await Promise.all([
          reorder(context, scope, [b.id, a.id]),
          approveSlide(deps, context, { slide: fresh.id, body: { versionNo: 1 } }),
          resumeSlide(deps, context, { slide: parked.id }),
        ]);
        // Neither the approval nor the resume is lost or deadlocked.
        expect(approvedFresh.ok).toBe(true);
        expect(resumed.ok).toBe(true);
        const order = await orderOf(market, scope);
        expect(new Set(order)).toEqual(new Set([a.id, b.id, fresh.id, parked.id]));
        expect(order).toHaveLength(4);
        if (moved.ok) {
          // The reorder ran first: its two slides are in the order asked.
          expect(order.filter((x) => x === a.id || x === b.id)).toEqual([b.id, a.id]);
        } else {
          // It ran after a placement was added: the list was stale, nothing was written.
          expect(moved).toMatchObject({
            ok: false,
            error: { code: 'storefront.slide-order-mismatch' },
          });
          expect(await saved(market, a.id)).toEqual([]);
        }
      }
    });

    it('serializes a reorder with a pause of a slide it names', async () => {
      for (let round = 0; round < 4; round += 1) {
        const scope = category();
        const [a, b, c] = [
          await inCategory(context, scope),
          await inCategory(context, scope),
          await inCategory(context, scope),
        ];
        const [moved, paused] = await Promise.all([
          reorder(context, scope, [c.id, b.id, a.id]),
          pauseSlide(deps, context, { slide: b.id }),
        ]);
        expect(paused.ok).toBe(true);
        const order = await orderOf(market, scope);
        expect(order).toHaveLength(2);
        expect(order).not.toContain(b.id);
        if (moved.ok) expect(order).toEqual([c.id, a.id]);
        else {
          expect(moved).toMatchObject({
            ok: false,
            error: { code: 'storefront.slide-order-mismatch' },
          });
          expect(await saved(market, a.id)).toEqual([]);
        }
      }
    });

    it('drops the saved orders of a slide that is archived', async () => {
      const scope = category();
      const [a, b] = [await inCategory(context, scope), await inCategory(context, scope)];
      ok(await reorder(context, scope, [b.id, a.id]));
      expect(await saved(market, a.id)).toHaveLength(1);
      ok(await archiveSlide(deps, context, { slide: a.id }));
      expect(await saved(market, a.id)).toEqual([]);
      expect(await saved(market, b.id)).toHaveLength(1);
      expect(await orderOf(market, scope)).toEqual([b.id]);
    });

    it('lets two opposite reorders finish with one whole order and no deadlock', async () => {
      const scope = category();
      const [a, b, c] = [
        await inCategory(context, scope),
        await inCategory(context, scope),
        await inCategory(context, scope),
      ];
      const results = await Promise.all([
        reorder(context, scope, [a.id, b.id, c.id]),
        reorder(context, scope, [c.id, b.id, a.id]),
        reorder(context, scope, [b.id, c.id, a.id]),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      const rows = await rowsOf(market, scope);
      expect(rows.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
      // The saved orders say what the rows say.
      for (const [index, slideId] of rows.map((p) => p.slideId).entries()) {
        expect((await saved(market, slideId)).map((o) => o.sortOrder)).toEqual([index]);
      }
    });
  });
});
