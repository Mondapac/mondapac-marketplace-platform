import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { StepUpActionRegistry } from '../../../../platform/authz';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { StepUpRepository } from '../ports/step-up.repository';
import { AdminStepUpConsumer } from './admin-step-up-consumer';

const NOW = Temporal.Instant.from('2026-10-25T10:00:00Z');
const ACTION = 'wallet.settings.change';
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SESSION = id<'Session'>(0xc2);

describe.each(['AU', 'ZZ'] as const)('AdminStepUpConsumer in market %s (issue #491)', (code) => {
  const market = testMarketContext(code, 'default');
  const registry = new StepUpActionRegistry();
  registry.register('wallet', [
    { key: ACTION, defaultRequired: true, locked: true, audience: 'admin' },
  ]);
  registry.register('pricing', [
    { key: 'pricing.price.change', defaultRequired: false, locked: false },
  ]);

  let proofs: Map<string, Temporal.Instant>;
  let taken: string[];
  let factorActive: boolean | null;
  let factorActivatedAt: Temporal.Instant | null;
  const stepUp = {
    takeProof: (_m: unknown, session: string, key: string) => {
      taken.push(`${session}:${key}`);
      const at = proofs.get(`${session}:${key}`) ?? null;
      proofs.delete(`${session}:${key}`);
      return Promise.resolve(at);
    },
  } as unknown as StepUpRepository;
  const factors = {
    findByAccount: () =>
      Promise.resolve(
        factorActive === null
          ? null
          : { isActive: factorActive, state: { activatedAt: factorActivatedAt } },
      ),
  } as unknown as SecondFactorRepository;
  const consumer = new AdminStepUpConsumer({
    stepUp,
    stepUpActions: registry,
    factors,
    clock: new FixedClock(NOW),
  });
  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id<'Account'>(0xa2),
        sessionId: SESSION,
        sellerId: null,
      }),
      'step-up-consume-0001',
    );

  beforeEach(() => {
    proofs = new Map();
    taken = [];
    factorActive = true;
    factorActivatedAt = NOW.subtract({ hours: 1 });
  });

  it('spends a fresh proof of this session once: the second call is refused', async () => {
    proofs.set(`${SESSION}:${ACTION}`, NOW.subtract({ minutes: 2 }));

    expect(await consumer.consume(admin(), ACTION)).toEqual({
      ok: true,
      value: { sessionId: SESSION, verifiedAt: NOW.subtract({ minutes: 2 }) },
    });
    expect(await consumer.consume(admin(), ACTION)).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: ACTION },
    });
  });

  it('refuses an expired proof, one older than the factor, and no proof', async () => {
    for (const [verifiedAt, activatedAt] of [
      [NOW.subtract({ minutes: 5 }), NOW.subtract({ hours: 1 })],
      [NOW.subtract({ minutes: 2 }), NOW.subtract({ minutes: 1 })],
    ] as const) {
      proofs.set(`${SESSION}:${ACTION}`, verifiedAt);
      factorActivatedAt = activatedAt;
      expect(await consumer.consume(admin(), ACTION)).toMatchObject({
        ok: false,
        error: { code: 'second-factor.required' },
      });
    }
    expect((await consumer.consume(admin(), ACTION)).ok).toBe(false);
  });

  it('asks an admin without an active factor to set one up, and takes nothing', async () => {
    proofs.set(`${SESSION}:${ACTION}`, NOW);
    factorActive = false;

    expect(await consumer.consume(admin(), ACTION)).toEqual({
      ok: false,
      error: { code: 'second-factor.enrolment-required', actionKey: ACTION },
    });
    expect(taken).toEqual([]);
  });

  it('refuses an acting-as session, a seller, a seller action and an unknown key; takes nothing', async () => {
    proofs.set(`${SESSION}:${ACTION}`, NOW);
    const context = admin();
    const actingAs = {
      ...context,
      actor: { ...context.actor, actingAs: { sellerId: id<'Seller'>(0xb1) } },
    } as unknown as CallContext;
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(0xa1),
        sessionId: id<'Session'>(0xc1),
        sellerId: id<'Seller'>(0xb1),
      }),
      'step-up-consume-0002',
    );

    expect(await consumer.consume(actingAs, ACTION)).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await consumer.consume(seller, ACTION)).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    for (const key of ['pricing.price.change', 'wallet.settings.unknown']) {
      expect(await consumer.consume(admin(), key)).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    }
    expect(taken).toEqual([]);
  });
});
