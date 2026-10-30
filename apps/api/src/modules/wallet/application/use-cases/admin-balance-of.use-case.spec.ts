import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AccessDecision } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { AdminBalanceOf } from './admin-balance-of.use-case';

// Hassan M1 (customers package 5c): the admin facade use case is not callable by any admin. It
// declares the protected key of the deletion; a Viewer admin is refused at the gate, before the
// use case or any dependency runs.
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId<T>(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad test id');
  return parsed.value;
};
const DELETE_KEY = 'customers.buyer-account.delete';

describe.each([['AU'], ['ZZ']] as const)('AdminBalanceOf in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id<'Account'>(0xad),
      sessionId: id<'Session'>(0x62),
      sellerId: null,
    }),
    'admin-facade-key-abcd',
  );
  // A gate whose check grants exactly the keys held: a Viewer holds only a view key.
  const gateFor = (held: readonly string[]) =>
    createUseCaseGate(markets, {
      check: (_context, declaration): Promise<AccessDecision> =>
        Promise.resolve(
          declaration.rule.kind === 'permissions' &&
            declaration.rule.allOf.every((key) => held.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        ),
    });
  const never = {} as never;

  it('declares the deletion key and nothing weaker', () => {
    expect(AdminBalanceOf.access.rule).toEqual({ kind: 'permissions', allOf: [DELETE_KEY] });
  });

  it('refuses a Viewer admin before any dependency runs', async () => {
    const useCase = new AdminBalanceOf(
      gateFor(['customers.account-deletion-requests.view']),
      never,
    );
    expect(await useCase.execute(admin, { customerAccountId: id<'Account'>(0x1) })).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});
