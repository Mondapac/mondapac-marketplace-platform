import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { isMinted, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import { openSession, type Session } from '../../domain/session';
import type { SessionTokens } from '../ports/session-secrets';
import { AccountAuthorisationCheck } from './account-authorisation-check';
import { SessionAuthenticator } from './session-authenticator';

// identity design 4, 5.2, 6.2 (slice 2): the Authenticator and the AuthorisationCheck, for both
// Market fixtures.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const TOKEN = `ms1_${'Q'.repeat(43)}`;
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');

const tokens: SessionTokens = {
  issue: () => {
    throw new Error('not issued here');
  },
  hashOf: (token) =>
    /^ms1_/.test(token) ? new Uint8Array(createHash('sha256').update(token).digest()) : null,
};

function account(code: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    id: ACCOUNT_ID,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: 'a@example.com', normalized: 'a@example.com' },
    displayName: null,
    status: 'active',
    emailVerifiedAt: START,
    existingAccountNoticeAt: null,
    signedUpAt: START,
    createdAt: START,
    version: 1,
    credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    ...overrides,
  };
}

describe.each(TEST_MARKETS)('identity access ports in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let fakes: IdentityFakes;
  let clock: FixedClock;
  let units: (UnitOfWorkOptions | undefined)[];
  let unitOfWork: UnitOfWork;
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    units = [];
    unitOfWork = {
      run: <T, E>(
        m: MarketContext,
        work: () => Promise<Result<T, E>>,
        options?: UnitOfWorkOptions,
      ) => {
        units.push(options);
        return fakes.unitOfWork.run(m, work);
      },
      runOnce: (m, delivery, work, options) => fakes.unitOfWork.runOnce(m, delivery, work, options),
    };
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fakes.seedAccount(account(code));
  });
  afterEach(() => warnings.mockRestore());

  function seedSession(overrides: Partial<Session> = {}): Session {
    const session = {
      ...openSession({
        id: SESSION_ID,
        marketId: market.marketId,
        accountId: ACCOUNT_ID,
        population: 'customer',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      ...overrides,
    };
    void fakes.sessionRepository.add(market, session, tokens.hashOf(TOKEN)!);
    return session;
  }

  describe('SessionAuthenticator', () => {
    const authenticator = () =>
      new SessionAuthenticator({ unitOfWork, sessions: fakes.sessionRepository, tokens, clock });

    it('builds a minted customer actor from a live session, in a read-only unit', async () => {
      seedSession();

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'cookie',
      });

      expect(result.ok).toBe(true);
      const actor = result.ok ? result.value : null;
      expect(isMinted(actor)).toBe(true);
      expect(actor).toMatchObject({
        kind: 'authenticated',
        marketId: code,
        population: 'customer',
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        sellerId: null,
      });
      // The read is read-only; no lastSeenAt write within the minute.
      expect(units).toEqual([{ readOnly: true }]);
    });

    it('writes lastSeenAt once a minute has passed, in a read-write unit of its own', async () => {
      seedSession();
      clock.advance(Temporal.Duration.from({ seconds: 61 }));

      await authenticator().authenticate(market, { token: TOKEN, transport: 'cookie' });

      expect(units).toEqual([{ readOnly: true }, undefined]);
      expect(fakes.sessions.get(SESSION_ID)!.session.lastSeenAt).toEqual(clock.now());
    });

    it('still authenticates when the lastSeenAt write fails, and logs it', async () => {
      seedSession();
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      fakes.sessionRepository.touch = () => Promise.reject(new Error('down'));

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'cookie',
      });

      expect(result.ok).toBe(true);
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'identity.session.last-seen-not-written' }),
      );
    });

    it.each<[string, () => void, { token?: string; transport?: 'cookie' | 'bearer' }]>([
      ['an unknown token', () => seedSession(), { token: `ms1_${'Z'.repeat(43)}` }],
      ['a malformed token', () => seedSession(), { token: 'not-a-token' }],
      ['the other transport', () => seedSession(), { transport: 'bearer' }],
      ['a revoked session', () => seedSession({ revokedAt: START, revokedReason: 'sign-out' }), {}],
      [
        'an idle session',
        () => {
          seedSession();
          clock.advance(Temporal.Duration.from({ seconds: LIFETIME.idleTimeoutSeconds }));
        },
        {},
      ],
      [
        'an expired session',
        () => {
          seedSession({ lastSeenAt: START.add({ seconds: 7000 }) });
          clock.advance(Temporal.Duration.from({ seconds: LIFETIME.absoluteLifetimeSeconds }));
        },
        {},
      ],
      [
        'a disabled account',
        () => {
          seedSession();
          fakes.seedAccount(account(code, { status: 'disabled' }));
        },
        {},
      ],
    ])('rejects %s with the one credential.rejected', async (_case, arrange, credential) => {
      arrange();

      await expect(
        authenticator().authenticate(market, {
          token: credential.token ?? TOKEN,
          transport: credential.transport ?? 'cookie',
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
    });

    it('rejects a session of another Market (AC 20)', async () => {
      seedSession();
      const other = testMarketContext(
        TEST_MARKETS.find((m) => m !== code)!,
        PLATFORM_TENANT_ID,
      );

      await expect(
        authenticator().authenticate(other, { token: TOKEN, transport: 'cookie' }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
    });
  });

  describe('AccountAuthorisationCheck', () => {
    const check = () =>
      new AccountAuthorisationCheck({
        unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        sellerAccess: fakes.sellerAccessRepository,
      });
    const actorContext = (population: 'customer' | 'admin' = 'customer') =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ACCOUNT_ID,
          sessionId: SESSION_ID,
          sellerId: null,
        }),
      );
    const ownResources = {
      name: 'identity.sign-out',
      rule: { kind: 'own-resources' as const },
      whenSellerNotApproved: 'allow' as const,
    };

    it('allows own-resources for an active account of the actor, read in a read-only unit', async () => {
      await expect(check().check(actorContext(), ownResources)).resolves.toEqual({ allowed: true });
      expect(units).toEqual([{ readOnly: true }]);
    });

    it('denies a disabled account, and an account of another population', async () => {
      fakes.seedAccount(account(code, { status: 'disabled' }));
      await expect(check().check(actorContext(), ownResources)).resolves.toEqual({
        allowed: false,
        denial: { code: 'access.denied' },
      });
      fakes.seedAccount(account(code));
      await expect(check().check(actorContext('admin'), ownResources)).resolves.toMatchObject({
        allowed: false,
      });
    });

    it('denies a permissions rule until slice 8a brings the registry', async () => {
      await expect(
        check().check(actorContext(), {
          name: 'identity.anything',
          rule: { kind: 'permissions', allOf: ['identity.role.view'] as never },
        }),
      ).resolves.toEqual({ allowed: false, denial: { code: 'access.denied' } });
      expect(units).toEqual([]);
    });

    it('denies the seller population until slice 5', async () => {
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ACCOUNT_ID,
          sessionId: SESSION_ID,
          sellerId: id<'Seller'>('01990000-0000-7000-8000-00000000b001'),
        }),
      );

      await expect(check().check(seller, ownResources)).resolves.toMatchObject({ allowed: false });
    });
  });
});
