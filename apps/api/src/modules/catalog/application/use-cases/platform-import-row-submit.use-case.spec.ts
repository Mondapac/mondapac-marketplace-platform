import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { SubmitProduct } from '../revisions/submit-product.service';
import { PlatformImportRowSubmit } from './platform-import-row-submit.use-case';

// `platform-import.row-submit` (catalog design 14a): the Inactive start asks the submit service to
// publish and pause in one unit; Active does not; an Inactive start needs the pause key of the
// admin the job runs as. The one-unit behaviour itself is in test/db (platform product submit).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const idOf = <K extends string>(n: number): Id<K> =>
  `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<K>;
const PRODUCT = '0190a000-0000-7000-8000-000000000042';

describe.each(['AU', 'ZZ'] as const)('platform-import.row-submit in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  function rig(held: readonly string[]) {
    const authorisation: AuthorisationCheck = {
      check: (_context, declaration) =>
        Promise.resolve(
          declaration.rule.kind === 'permissions' &&
            declaration.rule.allOf.every((key) => held.includes(key))
            ? { allowed: true }
            : ({ allowed: false, reason: 'missing-permission' } as never),
        ),
    };
    const calls: unknown[] = [];
    const submit = {
      execute: (_context: unknown, input: unknown) => {
        calls.push(input);
        return Promise.resolve({ ok: true, value: { revisionNo: 1, published: true } });
      },
    } as unknown as SubmitProduct;
    const useCase = new PlatformImportRowSubmit(createUseCaseGate(markets, authorisation), {
      submit,
      authorisation,
    });
    return { useCase, calls };
  }

  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: idOf<'Account'>(5),
      sessionId: idOf<'Session'>(6),
      sellerId: null,
    }),
  );
  const KEYS = ['catalog.platform-product.edit', 'catalog.platform-import.run'];

  it('asks for publish-and-pause in the one submit for an Inactive start', async () => {
    const r = rig([...KEYS, 'catalog.product.pause']);
    const result = await r.useCase.execute(admin, { productId: PRODUCT, startAs: 'inactive' });
    expect(result.ok).toBe(true);
    expect(r.calls).toEqual([
      expect.objectContaining({ productId: PRODUCT, pauseOnPublish: true, replacePending: false }),
    ]);
  });

  it('does not pause for an Active start, and needs no pause key for it', async () => {
    const r = rig(KEYS);
    const result = await r.useCase.execute(admin, { productId: PRODUCT, startAs: 'active' });
    expect(result.ok).toBe(true);
    expect(r.calls).toEqual([expect.objectContaining({ pauseOnPublish: false })]);
  });

  it('refuses an Inactive start to an admin who may not pause, and submits nothing', async () => {
    const r = rig(KEYS);
    const result = await r.useCase.execute(admin, { productId: PRODUCT, startAs: 'inactive' });
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(r.calls).toHaveLength(0);
  });

  it('refuses an admin without the import key, a bad id and an unknown start', async () => {
    const without = rig(['catalog.platform-product.edit', 'catalog.product.pause']);
    expect(
      (await without.useCase.execute(admin, { productId: PRODUCT, startAs: 'active' })).ok,
    ).toBe(false);
    const r = rig([...KEYS, 'catalog.product.pause']);
    expect(await r.useCase.execute(admin, { productId: 'nope', startAs: 'active' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(
      await r.useCase.execute(admin, { productId: PRODUCT, startAs: 'later' as never }),
    ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(r.calls).toHaveLength(0);
  });
});
