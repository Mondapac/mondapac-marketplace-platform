import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { openGate } from '../../../../../test/support/system-only-denial';
import { StepUpActionRegistry } from '../../../../platform/authz';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { StepUpRepository } from '../ports/step-up.repository';
import { RequireStepUp } from './require-step-up.use-case';

const NOW = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0xb1);
const SESSION = id<'Session'>(0xc1);

describe.each(['AU', 'ZZ'] as const)('RequireStepUp in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(NOW);
  const registry = new StepUpActionRegistry();
  registry.register('pricing', [
    { key: 'pricing.price.change', defaultRequired: false, locked: false },
  ]);
  registry.register('payments', [
    { key: 'payments.payout-account.change', defaultRequired: true, locked: true },
  ]);
  registry.register('wallet', [
    { key: 'wallet.settings.change', defaultRequired: true, locked: true, audience: 'admin' },
  ]);

  let rules: Map<string, boolean>;
  let proofs: Map<string, Temporal.Instant>;
  let proofSessions: string[];
  let factorActive: boolean | null;
  let factorActivatedAt: Temporal.Instant | null;

  const stepUp: StepUpRepository = {
    policiesOf: () => Promise.resolve([]),
    policyOf: (_m, _s, key) => Promise.resolve(rules.get(key) ?? null),
    savePolicy: () => Promise.resolve(),
    proofOf: (_m, session, key) => {
      proofSessions.push(session);
      return Promise.resolve(proofs.get(`${session}:${key}`) ?? proofs.get(key) ?? null);
    },
    recordProof: () => Promise.resolve(),
  };
  const factors = {
    findByAccount: () =>
      Promise.resolve(
        factorActive === null
          ? null
          : { isActive: factorActive, state: { activatedAt: factorActivatedAt } },
      ),
  } as unknown as SecondFactorRepository;
  const useCase = new RequireStepUp(openGate(), {
    unitOfWork: { run: (_m: unknown, work: () => Promise<unknown>) => work() } as never,
    stepUp,
    stepUpActions: registry,
    factors,
    clock,
  });
  const seller = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(0xa1),
        sessionId: SESSION,
        sellerId: SELLER,
      }),
      'step-up-unit-0001',
    );
  const run = (context: CallContext, actionKey: string) => useCase.execute(context, { actionKey });

  beforeEach(() => {
    rules = new Map();
    proofs = new Map();
    proofSessions = [];
    factorActive = true;
    factorActivatedAt = NOW.subtract({ hours: 1 });
  });

  it('does not accept a proof made before the current factor was activated', async () => {
    rules.set('pricing.price.change', true);
    proofs.set('pricing.price.change', NOW.subtract({ minutes: 2 }));
    factorActivatedAt = NOW.subtract({ minutes: 1 });

    expect(await run(seller(), 'pricing.price.change')).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: 'pricing.price.change' },
    });
  });

  it('lets an action through that the shop does not guard', async () => {
    expect(await run(seller(), 'pricing.price.change')).toEqual({
      ok: true,
      value: { code: 'step-up.satisfied' },
    });
  });

  it('asks for a code once the shop turns the rule on, and accepts a fresh proof', async () => {
    rules.set('pricing.price.change', true);

    expect(await run(seller(), 'pricing.price.change')).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: 'pricing.price.change' },
    });
    proofs.set('pricing.price.change', NOW.subtract({ minutes: 4, seconds: 59 }));
    expect((await run(seller(), 'pricing.price.change')).ok).toBe(true);
  });

  it('does not accept a proof of five minutes or older, a future one, or another action', async () => {
    rules.set('pricing.price.change', true);

    proofs.set('pricing.price.change', NOW.subtract({ minutes: 5 }));
    expect((await run(seller(), 'pricing.price.change')).ok).toBe(false);
    proofs.set('pricing.price.change', NOW.add({ seconds: 1 }));
    expect((await run(seller(), 'pricing.price.change')).ok).toBe(false);
    proofs.clear();
    proofs.set('payments.payout-account.change', NOW);
    expect((await run(seller(), 'pricing.price.change')).ok).toBe(false);
  });

  it('asks a member without two-step to set it up first', async () => {
    rules.set('pricing.price.change', true);
    for (const state of [null, false]) {
      factorActive = state;
      expect(await run(seller(), 'pricing.price.change')).toEqual({
        ok: false,
        error: { code: 'second-factor.enrolment-required', actionKey: 'pricing.price.change' },
      });
    }
  });

  it('keeps a locked action required whatever the shop stored', async () => {
    rules.set('payments.payout-account.change', false);

    expect(await run(seller(), 'payments.payout-account.change')).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: 'payments.payout-account.change' },
    });
  });

  it('is closed for an unregistered action, and not subject for a caller that is not a seller', async () => {
    expect(await run(seller(), 'pricing.unknown.thing')).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id<'Account'>(0xa2),
        sessionId: id<'Session'>(0xc2),
        sellerId: null,
      }),
      'step-up-unit-0002',
    );
    expect((await run(admin, 'payments.payout-account.change')).ok).toBe(true);
  });

  describe('an admin action (issue #491)', () => {
    const ADMIN_SESSION = id<'Session'>(0xc2);
    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: id<'Account'>(0xa2),
          sessionId: ADMIN_SESSION,
          sellerId: null,
        }),
        'step-up-unit-0003',
      );

    it('always asks an admin session for a fresh proof, and accepts one of this session', async () => {
      expect(await run(admin(), 'wallet.settings.change')).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: 'wallet.settings.change' },
      });
      proofs.set(`${ADMIN_SESSION}:wallet.settings.change`, NOW.subtract({ minutes: 4 }));
      expect(await run(admin(), 'wallet.settings.change')).toEqual({
        ok: true,
        value: { code: 'step-up.satisfied' },
      });
      expect(new Set(proofSessions)).toEqual(new Set([ADMIN_SESSION]));
    });

    it('does not accept an expired proof, one for another action or one of another session', async () => {
      proofs.set(`${ADMIN_SESSION}:wallet.settings.change`, NOW.subtract({ minutes: 5 }));
      expect((await run(admin(), 'wallet.settings.change')).ok).toBe(false);
      proofs.clear();
      proofs.set(`${ADMIN_SESSION}:payments.payout-account.change`, NOW);
      expect((await run(admin(), 'wallet.settings.change')).ok).toBe(false);
      proofs.clear();
      proofs.set(`${id<'Session'>(0xc9)}:wallet.settings.change`, NOW);
      expect((await run(admin(), 'wallet.settings.change')).ok).toBe(false);
    });

    it('asks an admin without an active factor to set one up', async () => {
      for (const state of [null, false]) {
        factorActive = state;
        expect(await run(admin(), 'wallet.settings.change')).toEqual({
          ok: false,
          error: { code: 'second-factor.enrolment-required', actionKey: 'wallet.settings.change' },
        });
      }
    });

    it('refuses a seller session and an acting-as session, even with a proof', async () => {
      proofs.set('wallet.settings.change', NOW);
      expect(await run(seller(), 'wallet.settings.change')).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      // Refused by the gate (a context it did not mint) or by the use case's own marker check:
      // either way no proof is read.
      const context = admin();
      const actingAs = {
        ...context,
        actor: { ...context.actor, actingAs: { sellerId: SELLER } },
      } as unknown as CallContext;
      expect(await run(actingAs, 'wallet.settings.change')).toMatchObject({ ok: false });
      expect(proofSessions).toEqual([]);
    });

    it('keeps an unregistered admin key closed', async () => {
      expect(await run(admin(), 'wallet.settings.unknown')).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    });
  });
});
