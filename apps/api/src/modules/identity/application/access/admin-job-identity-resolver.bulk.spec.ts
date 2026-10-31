import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { IdentityFakes } from '../../../../../test/support/identity-fakes';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { openSession, type SessionRevokedReason } from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import { AdminJobIdentityResolver } from './session-authenticator';

// Hassan M-585-1 (remainder): a session that was signed out escaped the bulk revocations because
// they skipped rows that were already revoked. The order of events: the import starts, the session
// signs out, then the account's sessions are ended in bulk for another reason. The job must stop.

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const OTHER_SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a002');
const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 1800, absoluteLifetimeSeconds: 86_400 };

/** The reasons `revokeAllOf` is called with for an account (not the seller-only ones). */
const ACCOUNT_BULK_REASONS: readonly SessionRevokedReason[] = [
  'password-reset',
  'password-changed',
  'second-factor-activated',
  'second-factor-replaced',
  'second-factor-reset',
  'account-disabled',
  'signed-out-elsewhere',
  'account-erasure',
];

describe.each(TEST_MARKETS)('AdminJobIdentityResolver after a sign-out in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  async function rig() {
    const fakes = new IdentityFakes();
    const job = openSession({
      id: SESSION_ID,
      marketId: code as MarketId,
      accountId: ACCOUNT_ID,
      population: 'admin',
      transport: 'cookie',
      lifetime: LIFETIME,
      now: T0,
    });
    await fakes.sessionRepository.add(market, job, new Uint8Array([1]));
    const unitOfWork = {
      run: async <T, E>(
        _m: MarketContext,
        work: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
      ) => work(),
    } as unknown as UnitOfWork;
    const accounts = {
      findById: () => Promise.resolve({ state: { population: 'admin', status: 'active' } }),
    } as unknown as AccountRepository;
    const resolver = new AdminJobIdentityResolver({
      unitOfWork,
      accounts,
      sessions: fakes.sessionRepository,
    });
    const resume = () =>
      resolver.resumeAdmin(market, { accountId: ACCOUNT_ID, sessionId: SESSION_ID });
    const signOut = () =>
      fakes.sessionRepository.revoke(
        market,
        SESSION_ID,
        ACCOUNT_ID,
        'sign-out',
        T0.add({ seconds: 60 }),
      );
    return { fakes, resume, signOut };
  }

  it('lets the job go on after a plain sign-out', async () => {
    const { resume, signOut } = await rig();
    expect(await resume()).not.toBeNull();
    expect(await signOut()).toBe(true);
    expect(await resume()).not.toBeNull();
  });

  it('stops after: start, sign out, change the password (the other session is kept)', async () => {
    const { fakes, resume, signOut } = await rig();
    await signOut();
    await fakes.sessionRepository.revokeAllOf(
      market,
      ACCOUNT_ID,
      'password-changed',
      T0.add({ seconds: 120 }),
      OTHER_SESSION_ID,
    );
    expect(await resume()).toBeNull();
  });

  it('keeps a bulk end from before the job began from stopping it', async () => {
    const { fakes, resume } = await rig();
    // A reset an hour before the session was opened is not news to the job.
    fakes.sessionsInvalidatedAt.set(ACCOUNT_ID, T0.subtract({ seconds: 3600 }));
    expect(await resume()).not.toBeNull();
  });

  it("keeps another account's bulk end from stopping it", async () => {
    const { fakes, resume, signOut } = await rig();
    await signOut();
    await fakes.sessionRepository.revokeAllOf(
      market,
      id<'Account'>('01990000-0000-7000-8000-000000000002'),
      'password-reset',
      T0.add({ seconds: 120 }),
      null,
    );
    expect(await resume()).not.toBeNull();
  });

  it.each(ACCOUNT_BULK_REASONS)(
    'stops after: start, sign out, then a bulk revocation for %s',
    async (reason) => {
      const { fakes, resume, signOut } = await rig();
      await signOut();
      const ended = await fakes.sessionRepository.revokeAllOf(
        market,
        ACCOUNT_ID,
        reason,
        T0.add({ seconds: 120 }),
        null,
      );
      expect(ended).toBe(0); // nothing was live: the count is still the sessions ended
      expect(await resume()).toBeNull();
    },
  );
});
