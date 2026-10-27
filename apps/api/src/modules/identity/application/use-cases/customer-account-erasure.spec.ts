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
import { openSession } from '../../domain/session';
import { EndOtherCustomerSessions } from './end-other-customer-sessions.use-case';
import { EraseCustomerAccount } from './erase-customer-account.use-case';

// Customers package 5b on identity's side: a customer ends their other sessions, and the deletion
// job erases the account (key destroyed, row and sessions gone), on both Market fixtures.

const START = Temporal.Instant.from('2026-10-26T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER_CUSTOMER = id<'Account'>(0xc2);
const ADMIN = id<'Account'>(0xa1);
const CURRENT = id<'Session'>(0xa001);
const LAPTOP = id<'Session'>(0xa002);
const PHONE = id<'Session'>(0xa003);
const OTHERS = id<'Session'>(0xa004);
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 12 * 3600 };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)(
  'customer account deletion on the identity side in market %s',
  (code) => {
    const market = testMarketContext(code, PLATFORM_TENANT_ID);
    const gate = createUseCaseGate(markets, allow);
    let fakes: IdentityFakes;

    function seedAccount(accountId: Id<'Account'>, population: 'admin' | 'customer') {
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
    function seedSession(sessionId: Id<'Session'>, accountId: Id<'Account'>) {
      const opened = openSession({
        id: sessionId,
        marketId: market.marketId,
        accountId,
        population: 'customer',
        sellerId: null,
        transport: 'cookie',
        device: null,
        lifetime: LIFETIME,
        now: START.subtract({ minutes: 10 }),
      });
      void fakes.sessionRepository.add(
        market,
        { ...opened, lastSeenAt: START },
        new Uint8Array(32).fill(Number.parseInt(sessionId.slice(-2), 16)),
      );
    }
    const deps = () => ({
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      sessions: fakes.sessionRepository,
      audit: fakes.audit,
      clock: new FixedClock(START),
    });
    const customer = (accountId = CUSTOMER, sessionId = CURRENT) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'customer',
          accountId,
          sessionId,
          sellerId: null,
        }),
      );
    const system = () => testCallContext(market, 'system', 'erasure-system-abcd');
    const live = (sessionId: Id<'Session'>) =>
      fakes.sessions.get(sessionId)?.session.revokedAt === null;

    beforeEach(() => {
      fakes = new IdentityFakes();
      seedAccount(CUSTOMER, 'customer');
      seedAccount(OTHER_CUSTOMER, 'customer');
      seedAccount(ADMIN, 'admin');
      seedSession(CURRENT, CUSTOMER);
      seedSession(LAPTOP, CUSTOMER);
      seedSession(PHONE, CUSTOMER);
      seedSession(OTHERS, OTHER_CUSTOMER);
    });

    describe('EndOtherCustomerSessions', () => {
      it('ends every other session of the own account and keeps the calling one', async () => {
        const ended = await new EndOtherCustomerSessions(gate, deps()).execute(customer(), {});
        expect(ended).toEqual({
          ok: true,
          value: { code: 'other-sessions-ended', revokedSessions: 2 },
        });
        expect(live(CURRENT)).toBe(true);
        expect(live(LAPTOP)).toBe(false);
        expect(live(PHONE)).toBe(false);
        // Another customer's session is untouched.
        expect(live(OTHERS)).toBe(true);
        expect(fakes.audits.map((a) => a.action)).toEqual([
          'identity.account.other-sessions-signed-out',
        ]);
        // The credential lock was taken first, as every session revocation does.
        expect(fakes.credentialLocks).toEqual([CUSTOMER]);
      });

      it('answers zero when the calling session is the only one', async () => {
        await new EndOtherCustomerSessions(gate, deps()).execute(customer(), {});
        const again = await new EndOtherCustomerSessions(gate, deps()).execute(customer(), {});
        expect(again).toEqual({
          ok: true,
          value: { code: 'other-sessions-ended', revokedSessions: 0 },
        });
      });

      it('refuses a session that is not live, and every non-customer', async () => {
        const gone = id<'Session'>(0xa0ff);
        expect(
          await new EndOtherCustomerSessions(gate, deps()).execute(customer(CUSTOMER, gone), {}),
        ).toEqual({ ok: false, error: { code: 'session.invalid' } });
        expect(live(LAPTOP)).toBe(true);
        const admin = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'admin',
            accountId: ADMIN,
            sessionId: CURRENT,
            sellerId: null,
          }),
        );
        expect(await new EndOtherCustomerSessions(gate, deps()).execute(admin, {})).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      });
    });

    describe('EraseCustomerAccount', () => {
      it('destroys the key, deletes the account and its sessions, and audits the id only', async () => {
        const erased = await new EraseCustomerAccount(gate, deps()).execute(system(), {
          accountId: CUSTOMER,
        });
        expect(erased).toEqual({ ok: true, value: { code: 'erased' } });
        expect(fakes.subjectKeys.get(CUSTOMER)).toBe('destroyed');
        expect(fakes.accounts.has(CUSTOMER)).toBe(false);
        expect([...fakes.sessions.keys()]).toEqual([OTHERS]);
        expect(fakes.accounts.has(OTHER_CUSTOMER)).toBe(true);
        expect(fakes.subjectKeys.get(OTHER_CUSTOMER)).not.toBe('destroyed');
        expect(fakes.audits).toHaveLength(1);
        expect(fakes.audits[0]).toMatchObject({
          action: 'identity.account.erased',
          targetId: CUSTOMER,
          actor: 'system',
        });
      });

      it('is safe to call twice: already erased, nothing more audited', async () => {
        await new EraseCustomerAccount(gate, deps()).execute(system(), { accountId: CUSTOMER });
        const again = await new EraseCustomerAccount(gate, deps()).execute(system(), {
          accountId: CUSTOMER,
        });
        expect(again).toEqual({ ok: true, value: { code: 'already-erased' } });
        expect(fakes.audits).toHaveLength(1);
      });

      it('refuses an admin account and changes nothing', async () => {
        const refused = await new EraseCustomerAccount(gate, deps()).execute(system(), {
          accountId: ADMIN,
        });
        expect(refused).toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(fakes.accounts.has(ADMIN)).toBe(true);
        expect(fakes.subjectKeys.get(ADMIN)).not.toBe('destroyed');
      });

      it('is for the system actor only', async () => {
        const refused = await new EraseCustomerAccount(gate, deps()).execute(customer(), {
          accountId: CUSTOMER,
        });
        expect(refused.ok).toBe(false);
        expect(fakes.accounts.has(CUSTOMER)).toBe(true);
      });
    });
  },
);
