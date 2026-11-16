import { err, ok, type Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { IdentityFacade } from '../../identity';
import { FacadeAdminNames } from './facade-admin-names';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const label = (n: number, displayName: string | null) => ({
  accountId: id(n) as Id<'Account'>,
  kind: 'member' as const,
  displayName,
});

/** identity's changeActors, answering from `answers` call by call. */
function identity(...answers: (() => unknown)[]) {
  const calls: string[][] = [];
  const facade = {
    changeActors: (_context: unknown, ids: readonly string[]) => {
      calls.push([...ids]);
      const next = answers.shift() ?? (() => ok([]));
      return Promise.resolve().then(next);
    },
  } as unknown as IdentityFacade;
  return { facade, calls };
}

describe.each(TEST_MARKET_IDS)('FacadeAdminNames (%s)', (marketId) => {
  const context = testCallContext(testMarketContext(marketId, 'default'), 'system');

  it('names each admin once, in batches of 100, and leaves out blank or hidden names', async () => {
    const ids = Array.from({ length: 150 }, (_, n) => id(n));
    const { facade, calls } = identity(
      () => ok([label(1, 'Hassan R.'), label(2, ''), label(3, null)]),
      () => ok([label(120, 'Kazem M.')]),
    );
    const names = await new FacadeAdminNames(facade).namesOf(context, [...ids, id(1)]);
    expect(calls.map((batch) => batch.length)).toEqual([100, 50]);
    expect([...names]).toEqual([
      [id(1), 'Hassan R.'],
      [id(120), 'Kazem M.'],
    ]);
  });

  it('gives no names when a later batch is refused', async () => {
    const ids = Array.from({ length: 101 }, (_, n) => id(n));
    const { facade } = identity(
      () => ok([label(1, 'Hassan R.')]),
      () => err({ kind: 'access-denied' }),
    );
    expect((await new FacadeAdminNames(facade).namesOf(context, ids)).size).toBe(0);
  });

  it('gives no names, and does not throw, when identity fails', async () => {
    const { facade } = identity(() => {
      throw new Error('pool exhausted');
    });
    await expect(new FacadeAdminNames(facade).namesOf(context, [id(1)])).resolves.toEqual(
      new Map(),
    );
  });

  it('asks nothing for no ids', async () => {
    const { facade, calls } = identity();
    expect((await new FacadeAdminNames(facade).namesOf(context, [])).size).toBe(0);
    expect(calls).toEqual([]);
  });
});
