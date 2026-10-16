import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
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
import type { DeviceCode } from '../../domain/device';
import { openSession } from '../../domain/session';
import { ListOwnSessions } from './list-own-sessions.use-case';
import { SignOutOtherSessions } from './sign-out-other-sessions.use-case';

// The holder's own signed-in devices and "sign out of all other devices" (profile package 4),
// for both Market fixtures.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a1');
const OTHER_ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a2');
const SELLER_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-0000000000b1');
const CUSTOMER_ID = id<'Account'>('01990000-0000-7000-8000-0000000000c1');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000d1');
const CURRENT = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const LAPTOP = id<'Session'>('01990000-0000-7000-8000-00000000a002');
const PHONE = id<'Session'>('01990000-0000-7000-8000-00000000a003');
const IDLE = id<'Session'>('01990000-0000-7000-8000-00000000a004');
const SIGNED_OUT = id<'Session'>('01990000-0000-7000-8000-00000000a005');
const OTHER_ACCOUNTS = id<'Session'>('01990000-0000-7000-8000-00000000a006');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 12 * 3600 };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('own sessions in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;

  function seedAccount(accountId: Id<'Account'>, population: 'admin' | 'seller' | 'customer') {
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: `${accountId}@example.com`, normalized: `${accountId}@example.com` },
      displayName: population === 'customer' ? null : 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: START.subtract({ hours: 49 }),
      createdAt: START.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START.subtract({ hours: 49 }) },
    });
  }

  function seedSession(
    sessionId: Id<'Session'>,
    accountId: Id<'Account'>,
    openedMinutesAgo: number,
    lastSeenMinutesAgo: number,
    device: DeviceCode | null,
    population: 'admin' | 'seller' = 'admin',
  ) {
    const opened = openSession({
      id: sessionId,
      marketId: market.marketId,
      accountId,
      population,
      sellerId: population === 'seller' ? SELLER_ID : null,
      transport: 'cookie',
      device,
      lifetime: LIFETIME,
      now: START.subtract({ minutes: openedMinutesAgo }),
    });
    void fakes.sessionRepository.add(
      market,
      { ...opened, lastSeenAt: START.subtract({ minutes: lastSeenMinutesAgo }) },
      new Uint8Array(32).fill(Number.parseInt(sessionId.slice(-2), 16)),
    );
  }

  beforeEach(() => {
    fakes = new IdentityFakes();
    seedAccount(ADMIN_ID, 'admin');
    seedAccount(OTHER_ADMIN_ID, 'admin');
    seedSession(CURRENT, ADMIN_ID, 30, 0, 'chrome.windows');
    seedSession(LAPTOP, ADMIN_ID, 300, 5, 'safari.macos');
    seedSession(PHONE, ADMIN_ID, 200, 20, null);
    // Past its one-hour idle timeout: not live, so neither listed nor counted.
    seedSession(IDLE, ADMIN_ID, 400, 90, 'firefox.linux');
    seedSession(SIGNED_OUT, ADMIN_ID, 100, 10, 'edge.windows');
    void fakes.sessionRepository.revoke(
      market,
      SIGNED_OUT,
      ADMIN_ID,
      'sign-out',
      START.subtract({ minutes: 9 }),
    );
    seedSession(OTHER_ACCOUNTS, OTHER_ADMIN_ID, 50, 1, 'chrome.android');
  });

  const deps = () => ({
    unitOfWork: fakes.unitOfWork,
    accounts: fakes.accountRepository,
    sessions: fakes.sessionRepository,
    audit: fakes.audit,
    clock: new FixedClock(START),
  });
  const contextOf = (
    population: 'admin' | 'seller' | 'customer',
    accountId: Id<'Account'>,
    sessionId: Id<'Session'> = CURRENT,
  ) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId,
        sellerId: population === 'seller' ? SELLER_ID : null,
      }),
    );
  const sessionOf = (sessionId: Id<'Session'>) => fakes.sessions.get(sessionId)!.session;

  describe('ListOwnSessions', () => {
    it('lists the live sessions of the own account only, the current one first', async () => {
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      expect(result).toEqual({
        ok: true,
        value: {
          items: [
            {
              device: 'chrome.windows',
              signedInAt: START.subtract({ minutes: 30 }).toString(),
              lastActiveAt: START.toString(),
              current: true,
            },
            {
              device: 'safari.macos',
              signedInAt: START.subtract({ minutes: 300 }).toString(),
              lastActiveAt: START.subtract({ minutes: 5 }).toString(),
              current: false,
            },
            {
              device: null,
              signedInAt: START.subtract({ minutes: 200 }).toString(),
              lastActiveAt: START.subtract({ minutes: 20 }).toString(),
              current: false,
            },
          ],
        },
      });
    });

    it('answers no session id, token or address', async () => {
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      if (!result.ok) throw new Error('expected the list');
      for (const item of result.value.items) {
        expect(Object.keys(item).sort()).toEqual([
          'current',
          'device',
          'lastActiveAt',
          'signedInAt',
        ]);
      }
    });

    it('lists a seller-side member the same way', async () => {
      seedAccount(SELLER_ACCOUNT_ID, 'seller');
      const SELLER_SESSION = id<'Session'>('01990000-0000-7000-8000-00000000b001');
      seedSession(SELLER_SESSION, SELLER_ACCOUNT_ID, 10, 0, 'samsung.android', 'seller');
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('seller', SELLER_ACCOUNT_ID, SELLER_SESSION),
        {},
      );
      expect(result.ok && result.value.items.map((item) => item.device)).toEqual([
        'samsung.android',
      ]);
    });

    it('refuses a customer', async () => {
      seedAccount(CUSTOMER_ID, 'customer');
      const result = await new ListOwnSessions(gate, deps()).execute(
        contextOf('customer', CUSTOMER_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('SignOutOtherSessions', () => {
    it('ends every other session of the own account and keeps the current one', async () => {
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      // The idle one is not revoked yet, so it is ended too: it could never be used again anyway.
      expect(result).toEqual({
        ok: true,
        value: { code: 'other-sessions-signed-out', revokedSessions: 3 },
      });
      expect(sessionOf(CURRENT).revokedAt).toBeNull();
      for (const ended of [LAPTOP, PHONE, IDLE]) {
        expect(sessionOf(ended).revokedReason).toBe('signed-out-elsewhere');
        expect(sessionOf(ended).revokedAt).toEqual(START);
      }
      // Already signed out: keeps its own reason.
      expect(sessionOf(SIGNED_OUT).revokedReason).toBe('sign-out');
      // Another account's session is never touched.
      expect(sessionOf(OTHER_ACCOUNTS).revokedAt).toBeNull();
    });

    it('records the action with the kept session and the count, nothing personal', async () => {
      await new SignOutOtherSessions(gate, deps()).execute(contextOf('admin', ADMIN_ID), {});
      const entries = fakes.audits.filter(
        (entry) => entry.action === 'identity.account.other-sessions-signed-out',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetId: ADMIN_ID,
        after: { keptSessionId: CURRENT, revokedSessions: 3 },
      });
    });

    it('answers 0 and still records when there is no other session', async () => {
      const first = new SignOutOtherSessions(gate, deps());
      await first.execute(contextOf('admin', ADMIN_ID), {});
      const again = await first.execute(contextOf('admin', ADMIN_ID), {});
      expect(again).toEqual({
        ok: true,
        value: { code: 'other-sessions-signed-out', revokedSessions: 0 },
      });
      expect(
        fakes.audits.filter((e) => e.action === 'identity.account.other-sessions-signed-out'),
      ).toHaveLength(2);
    });

    it('changes nothing when the current session was revoked meanwhile', async () => {
      await fakes.sessionRepository.revoke(market, CURRENT, ADMIN_ID, 'sign-out', START);
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'session.invalid' } });
      expect(sessionOf(LAPTOP).revokedAt).toBeNull();
      expect(fakes.audits).toHaveLength(0);
    });

    it('refuses a session that is not the account’s own', async () => {
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('admin', ADMIN_ID, OTHER_ACCOUNTS),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'session.invalid' } });
      expect(sessionOf(LAPTOP).revokedAt).toBeNull();
    });

    it('refuses a customer', async () => {
      seedAccount(CUSTOMER_ID, 'customer');
      const result = await new SignOutOtherSessions(gate, deps()).execute(
        contextOf('customer', CUSTOMER_ID),
        {},
      );
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });
});
