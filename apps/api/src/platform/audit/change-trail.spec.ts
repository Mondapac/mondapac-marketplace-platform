import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  changeHistoryInputOf,
  changedFields,
  ChangeTrail,
  conflictDetails,
  lastChangedBody,
  type ChangeScope,
} from './change-trail';
import {
  changeTrailOf,
  FakeChangeActors,
  InMemoryAuditTrail,
} from '../../../test/support/change-trail-fakes';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';

// The platform "last changed" and history machinery (every settings page of every module uses it).
// Two Markets: the audit rows and the names of one never show in the other.

const START = Temporal.Instant.from('2026-10-15T10:00:00Z');
const MARKETS = ['AU', 'ZZ'] as const;
const SCOPE: ChangeScope = { actions: ['x.settings.changed'], targetId: null };
const unitOfWork: UnitOfWork = {
  run: (_market, work) => work(),
  runOnce: () => {
    throw new Error('unused');
  },
};

const contextOf = (code: string, accountId: string) =>
  testCallContext(
    testMarketContext(code, 'default'),
    testAuthenticatedActor(testMarketContext(code, 'default'), {
      population: 'admin',
      accountId: accountId as never,
      sessionId: '0199aaaa-0000-7000-8000-0000000000ff' as never,
      sellerId: null,
    }),
  );

const ADMIN = '0199aaaa-0000-7000-8000-000000000001';

describe('changedFields', () => {
  it('names the keys that differ, sorted, without version, and never a value', () => {
    expect(changedFields({ a: 1, b: 2, version: 1 }, { a: 1, b: 3, c: [1], version: 2 })).toEqual([
      'b',
      'c',
    ]);
  });

  it('treats a missing side as empty and skips ignored keys and non-field names', () => {
    expect(changedFields(null, { reason: 'x', proof: 'y', 'bad key': 1 }, ['proof'])).toEqual([
      'reason',
    ]);
  });
});

describe('request helpers', () => {
  it('turns a digits-only limit into a number and passes anything else on to be refused', () => {
    expect(changeHistoryInputOf({ limit: '5', after: 'abc' })).toEqual({ limit: 5, after: 'abc' });
    expect(changeHistoryInputOf({}).limit).toBeUndefined();
    expect(changeHistoryInputOf({ limit: '5x' }).limit).toBe('invalid');
    expect(changeHistoryInputOf({ limit: ['5'] }).limit).toBe('invalid');
  });

  it('adds details only to a refusal that carries the winning save', () => {
    expect(conflictDetails({ code: 'conflict.stale' })).toBeUndefined();
    expect(conflictDetails({ code: 'conflict.stale', lastChanged: null })).toEqual({
      lastChanged: null,
    });
    expect(
      conflictDetails({
        lastChanged: { at: START, byDisplayName: 'Sara K.', byKind: 'member' },
      }),
    ).toEqual({
      lastChanged: { at: '2026-10-15T10:00:00Z', byDisplayName: 'Sara K.', byKind: 'member' },
    });
    expect(lastChangedBody(null)).toBeNull();
  });
});

describe.each(MARKETS)('ChangeTrail in %s', (code) => {
  function setUp() {
    const clock = new FixedClock(START);
    const audit = new InMemoryAuditTrail(clock);
    const actors = new FakeChangeActors();
    const trail = changeTrailOf(unitOfWork, audit, actors);
    const context = contextOf(code, ADMIN);
    const save = async (after: Record<string, unknown>, before: Record<string, unknown> = {}) => {
      await audit.record(context, {
        action: 'x.settings.changed',
        targetType: 'x.settings',
        targetId: 'page',
        before,
        after,
      });
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
    };
    return { clock, audit, actors, trail, context, save };
  }

  it('answers null for a page never changed', async () => {
    const t = setUp();
    expect(await t.trail.lastChanged(t.context, SCOPE)).toBeNull();
  });

  it('names the newest change by display name, never the account id', async () => {
    const t = setUp();
    t.actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    await t.save({ reason: 'a' });
    await t.save({ reason: 'b' }, { reason: 'a' });

    const last = await t.trail.lastChanged(t.context, SCOPE);

    expect(last).toEqual({
      at: START.add({ minutes: 1 }),
      byDisplayName: 'Sara K.',
      byKind: 'member',
    });
    expect(JSON.stringify(last)).not.toContain(ADMIN);
  });

  it('says platform with no name for Mondapac staff and member with no name for an unnamed account', async () => {
    const t = setUp();
    await t.save({ reason: 'a' });
    t.actors.labels.set(ADMIN, { kind: 'platform', displayName: null });
    expect(await t.trail.lastChanged(t.context, SCOPE)).toMatchObject({
      byDisplayName: null,
      byKind: 'platform',
    });
    t.actors.labels.clear();
    expect(await t.trail.lastChanged(t.context, SCOPE)).toMatchObject({
      byDisplayName: null,
      byKind: 'member',
    });
  });

  it('still opens the page when identity cannot answer: last changed is null, not an error', async () => {
    const t = setUp();
    await t.save({ reason: 'a' });
    t.actors.failure = new Error('identity down');
    expect(await t.trail.lastChanged(t.context, SCOPE)).toBeNull();
  });

  it('adds the winning save to a conflict and leaves other results alone', async () => {
    const t = setUp();
    t.actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    await t.save({ reason: 'a' });

    const named = await t.trail.namingTheWinner(t.context, SCOPE, err({ code: 'conflict.stale' }), [
      'conflict.stale',
    ]);
    const other = await t.trail.namingTheWinner(t.context, SCOPE, err({ code: 'other' }), [
      'conflict.stale',
    ]);
    const fine = await t.trail.namingTheWinner(t.context, SCOPE, ok(1), ['conflict.stale']);

    expect(named).toEqual({
      ok: false,
      error: {
        code: 'conflict.stale',
        lastChanged: { at: START, byDisplayName: 'Sara K.', byKind: 'member' },
      },
    });
    expect(other).toEqual({ ok: false, error: { code: 'other' } });
    expect(fine).toEqual({ ok: true, value: 1 });
  });

  it('pages the history newest first with changed field names only', async () => {
    const t = setUp();
    t.actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    await t.save({ reason: 'secret-1', status: 'on' });
    await t.save({ reason: 'secret-2', status: 'on' }, { reason: 'secret-1', status: 'on' });
    await t.save({ reason: 'secret-2', status: 'off' }, { reason: 'secret-2', status: 'on' });

    const first = await t.trail.history(t.context, SCOPE, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.items.map((i) => i.fields)).toEqual([['status'], ['reason']]);
    expect(first.value.next).not.toBeNull();

    const second = await t.trail.history(t.context, SCOPE, {
      limit: 2,
      after: first.value.next,
    });
    expect(second.ok && second.value.items).toHaveLength(1);
    expect(second.ok && second.value.next).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain('secret');
    expect(JSON.stringify([first, second])).not.toContain(ADMIN);
  });

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 51 }, 'limit'],
    [{ limit: 'invalid' as never }, 'limit'],
    [{ after: 'not-an-id' }, 'after'],
    [{ after: '0199aaaa-0000-7000-8000-0000000000ee' }, 'after'],
  ])('refuses %j as validation.failed on %s', async (input, path) => {
    const t = setUp();
    await t.save({ reason: 'a' });
    const result = await t.trail.history(t.context, SCOPE, input);
    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: expect.any(String) as string }] },
    });
  });

  it('does not show the rows of the other Market', async () => {
    const t = setUp();
    await t.save({ reason: 'a' });
    const other = MARKETS.find((m) => m !== code)!;
    const there = await t.trail.history(contextOf(other, ADMIN), SCOPE, {});
    expect(there.ok && there.value.items).toEqual([]);
  });

  it('is a ChangeTrail', () => {
    expect(setUp().trail).toBeInstanceOf(ChangeTrail);
  });
});
