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
  const approved = async (target: CallContext, hours = 0) => {
    const created = ok(await createSlide(deps, target, draft(hours)));
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
});
