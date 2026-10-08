import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import type { AccessDecision, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { openSession } from '../../domain/session';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { IdentityFacadeImplementation } from '../../presentation/identity.facade';
import { DescribeActor } from './describe-actor.use-case';
import {
  LINK_KEPT_AFTER_SPENT_HOURS,
  MAX_RECORD_DAYS_PER_RUN,
  PurgeExpired,
  SESSION_KEPT_AFTER_EXPIRY_HOURS,
  THROTTLE_KEPT_HOURS,
} from './purge-expired.use-case';
import { SignOut } from './sign-out.use-case';

// Sign-out, the actor summary and its facade, and identity.purge-expired (identity design 3.5,
// 8.1, 8.6, 12.2; data design 3.4 to 3.6, 9), for both Market fixtures.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('session use cases in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const actor = testAuthenticatedActor(market, {
    population: 'customer',
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    sellerId: null,
  });
  const context = testCallContext(market, actor);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;
  let clock: FixedClock;
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fakes.seedAccount({
      id: ACCOUNT_ID,
      marketId: market.marketId,
      population: 'customer',
      email: { typed: 'Me@Example.com', normalized: 'me@example.com' },
      displayName: null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: SESSION_ID,
        marketId: market.marketId,
        accountId: ACCOUNT_ID,
        population: 'customer',
        transport: 'cookie',
        lifetime: policy.sessionLifetime(market, 'customer')!,
        now: START,
      }),
      new Uint8Array(createHash('sha256').update('token').digest()),
    );
  });
  afterEach(() => warnings.mockRestore());

  describe('SignOut', () => {
    const signOut = () =>
      new SignOut(gate, { unitOfWork: fakes.unitOfWork, sessions: fakes.sessionRepository, clock });

    it('declares own-resources, allowed for a seller that is not approved', () => {
      expect(SignOut.access).toEqual({
        name: 'identity.sign-out',
        rule: { kind: 'own-resources' },
        whenSellerNotApproved: 'allow',
      });
    });

    it("revokes the actor's own session with the reason sign-out; twice answers the same", async () => {
      await expect(signOut().execute(context, {})).resolves.toEqual({
        ok: true,
        value: { code: 'signed-out' },
      });
      expect(fakes.sessions.get(SESSION_ID)!.session).toMatchObject({
        revokedAt: START,
        revokedReason: 'sign-out',
      });
      await expect(signOut().execute(context, {})).resolves.toMatchObject({ ok: true });
    });

    it('is refused to an anonymous caller with access.unauthenticated', async () => {
      await expect(signOut().execute(testCallContext(market, 'anonymous'), {})).resolves.toEqual({
        ok: false,
        error: { code: 'access.unauthenticated' },
      });
    });
  });

  describe('DescribeActor and the facade', () => {
    const describeActor = () =>
      new DescribeActor(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        sessions: fakes.sessionRepository,
        assignments: fakes.assignmentRepository,
        sellerAccess: fakes.sellerAccessRepository,
      });
    // Only describeActor is called here; the other methods have their own suites.
    const facadeOf = (describe: DescribeActor) =>
      new IdentityFacadeImplementation({
        describeActor: describe,
        membershipOf: undefined as never,
      });

    it("answers the actor's ids, email and session times; the facade drops the email", async () => {
      const lifetime = policy.sessionLifetime(market, 'customer')!;
      const summary = await describeActor().execute(context, {});

      expect(summary).toEqual({
        ok: true,
        value: {
          accountId: ACCOUNT_ID,
          population: 'customer',
          sellerId: null,
          roleId: null,
          permissionKeys: [],
          sellerAccessState: null,
          secondFactorActive: false,
          email: 'Me@Example.com',
          displayName: null,
          session: {
            idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
            absoluteExpiresAt: START.add({ seconds: lifetime.absoluteLifetimeSeconds }).toString(),
          },
        },
      });
      const facade = await facadeOf(describeActor()).describeActor(context);
      expect(facade).toEqual({
        ok: true,
        value: {
          accountId: ACCOUNT_ID,
          population: 'customer',
          sellerId: null,
          roleId: null,
          permissionKeys: [],
          sellerAccessState: null,
          secondFactorActive: false,
        },
      });
      expect(JSON.stringify(facade)).not.toContain('Example.com');
    });

    it('is refused to an anonymous caller through the facade too (the gate runs)', async () => {
      await expect(
        facadeOf(describeActor()).describeActor(testCallContext(market, 'anonymous')),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
    });
  });

  describe('PurgeExpired (identity.purge-expired)', () => {
    function purge(unitOfWork: UnitOfWork = fakes.unitOfWork) {
      return new PurgeExpired(gate, {
        unitOfWork,
        sessions: fakes.sessionRepository,
        throttles: fakes.throttleRepository,
        records: fakes.recordRepository,
        links: fakes.linkRepository,
        policy,
        clock,
      });
    }

    it('declares the system rule and refuses any other actor', async () => {
      expect(PurgeExpired.access).toEqual({
        name: 'identity.purge-expired',
        rule: { kind: 'system' },
      });
      await expect(purge().execute(context, {})).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it("deletes by the cut-offs of data design 9 and the Market's retention, one day per unit", async () => {
      const cutoffs: Record<string, Temporal.Instant[]> = {
        sessions: [],
        throttles: [],
        records: [],
        links: [],
      };
      fakes.linkRepository.purgeSpent = (_m, before) => {
        cutoffs.links!.push(before);
        return Promise.resolve(4);
      };
      fakes.sessionRepository.purgeExpired = (_m, before) => {
        cutoffs.sessions!.push(before);
        return Promise.resolve(2);
      };
      fakes.throttleRepository.purge = (_m, before) => {
        cutoffs.throttles!.push(before);
        return Promise.resolve(3);
      };
      const retention = policy.signInRecordRetentionDays(market);
      const cutoff = START.subtract({ hours: retention * 24 });
      fakes.recordRepository.oldest = () => Promise.resolve(cutoff.subtract({ hours: 36 }));
      fakes.recordRepository.deleteBetween = (_m, from, to) => {
        cutoffs.records!.push(from, to);
        return Promise.resolve(1);
      };
      let units = 0;
      const counting: UnitOfWork = {
        run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>) => {
          units += 1;
          return fakes.unitOfWork.run(m, work);
        },
        runOnce: (m, delivery, work, options) =>
          fakes.unitOfWork.runOnce(m, delivery, work, options),
      };

      await expect(purge(counting).execute(testCallContext(market, 'system'), {})).resolves.toEqual(
        {
          ok: true,
          value: { sessions: 2, throttles: 3, signInRecords: 2, links: 4 },
        },
      );
      expect(cutoffs.sessions).toEqual([
        START.subtract({ hours: SESSION_KEPT_AFTER_EXPIRY_HOURS }),
      ]);
      expect(cutoffs.throttles).toEqual([START.subtract({ hours: THROTTLE_KEPT_HOURS })]);
      expect(cutoffs.links).toEqual([START.subtract({ hours: LINK_KEPT_AFTER_SPENT_HOURS })]);
      expect(cutoffs.records).toEqual([
        cutoff.subtract({ hours: 36 }),
        cutoff.subtract({ hours: 12 }),
        cutoff.subtract({ hours: 12 }),
        cutoff,
      ]);
      // sessions, throttles, the oldest record, two days of records, links.
      expect(units).toBe(6);
    });

    it('bounds the record deletes of one run', async () => {
      fakes.recordRepository.oldest = () => Promise.resolve(START.subtract({ hours: 24 * 5000 }));
      let deletes = 0;
      fakes.recordRepository.deleteBetween = () => {
        deletes += 1;
        return Promise.resolve(0);
      };

      await purge().execute(testCallContext(market, 'system'), {});

      expect(deletes).toBe(MAX_RECORD_DAYS_PER_RUN);
    });
  });
});
