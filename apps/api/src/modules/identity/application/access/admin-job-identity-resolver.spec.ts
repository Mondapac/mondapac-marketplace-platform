import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SESSION_REVOKED_REASONS, type SessionRevokedReason } from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';
import { AdminJobIdentityResolver, SESSION_REASONS_THAT_LEAVE_JOBS } from './session-authenticator';

// A background job that an admin started (the platform import, catalog design 14a) runs as that
// admin later. Only a sign-out and natural expiry let it go on; every other revocation reason
// stops it (Hassan M-585-1: the earlier deny-list failed open for a hijacked session).

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');

/** What each reason does to a running job. Adding a reason to the domain fails the build here. */
const JOB_CONTINUES: Record<SessionRevokedReason, boolean> = {
  'sign-out': true,
  'password-reset': false,
  'password-changed': false,
  'second-factor-activated': false,
  'second-factor-replaced': false,
  'second-factor-reset': false,
  'account-disabled': false,
  'membership-removed': false,
  'seller-rejected': false,
  'seller-suspended': false,
  'signed-out-elsewhere': false,
  'account-erasure': false,
};

describe.each(TEST_MARKETS)('AdminJobIdentityResolver in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  function resolver(session: {
    revokedAt: Temporal.Instant | null;
    revokedReason: string | null;
    population?: string;
  }) {
    const unitOfWork = {
      run: async <T, E>(
        _m: MarketContext,
        work: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
      ) => work(),
    } as unknown as UnitOfWork;
    const sessions = {
      findById: () =>
        Promise.resolve({
          id: SESSION_ID,
          marketId: code,
          accountId: ACCOUNT_ID,
          population: session.population ?? 'admin',
          sellerId: null,
          revokedAt: session.revokedAt,
          revokedReason: session.revokedReason,
        }),
    } as unknown as SessionRepository;
    const accounts = {
      findById: () => Promise.resolve({ state: { population: 'admin', status: 'active' } }),
    } as unknown as AccountRepository;
    return new AdminJobIdentityResolver({ unitOfWork, accounts, sessions });
  }
  const resume = (session: Parameters<typeof resolver>[0]) =>
    resolver(session).resumeAdmin(market, { accountId: ACCOUNT_ID, sessionId: SESSION_ID });

  it('walks every revocation reason: only a sign-out lets the job go on', async () => {
    expect(new Set(Object.keys(JOB_CONTINUES))).toEqual(new Set(SESSION_REVOKED_REASONS));
    for (const reason of SESSION_REVOKED_REASONS) {
      const actor = await resume({ revokedAt: T0, revokedReason: reason });
      expect([reason, actor !== null]).toEqual([reason, JOB_CONTINUES[reason]]);
    }
    expect([...SESSION_REASONS_THAT_LEAVE_JOBS]).toEqual(['sign-out']);
  });

  it('lets the job go on for a session that was never revoked (expiry or idleness)', async () => {
    expect(await resume({ revokedAt: null, revokedReason: null })).not.toBeNull();
  });

  it('stops the job for a revocation with an unknown or missing reason (fail closed)', async () => {
    expect(await resume({ revokedAt: T0, revokedReason: 'something-new' })).toBeNull();
    expect(await resume({ revokedAt: T0, revokedReason: null })).toBeNull();
  });

  it('still refuses a session of another population', async () => {
    expect(await resume({ revokedAt: null, revokedReason: null, population: 'seller' })).toBeNull();
  });
});
