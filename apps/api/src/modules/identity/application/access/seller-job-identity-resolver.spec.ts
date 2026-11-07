import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { IdentityFakes } from '../../../../../test/support/identity-fakes';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  openSession,
  SESSION_REVOKED_REASONS,
  type Session,
  type SessionRevokedReason,
} from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import {
  SellerJobIdentityResolver,
  SESSION_REASONS_THAT_LEAVE_JOBS,
} from './session-authenticator';

// A background job that a seller's account started (the seller import, catalog design 14c) runs as
// that account later. Mirrors the admin resolver's specs: only a sign-out and natural expiry let it
// go on; every other revocation reason, a bulk end after the session began, a lost membership, a
// disabled account, an acting-as session and another seller's session stop it. The resolver answers
// null for each, and never reads the seller's own state (a suspension is the caller's to tell apart).

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const OTHER_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000002');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const OTHER_SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a002');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const OTHER_SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b002');
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 1800, absoluteLifetimeSeconds: 86_400 };

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

/** The reasons `revokeAllOf` is called with for an account. */
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

describe.each(TEST_MARKETS)('SellerJobIdentityResolver in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  interface RigOptions {
    readonly account?: { population: string; status: string };
    readonly membership?: { state: string; sellerId: Id<'Seller'> } | null;
    readonly sessionSellerId?: Id<'Seller'>;
    readonly population?: 'seller' | 'admin';
    readonly actingAs?: unknown;
  }

  async function rig(options: RigOptions = {}) {
    const fakes = new IdentityFakes();
    const opened = openSession({
      id: SESSION_ID,
      marketId: code as MarketId,
      accountId: ACCOUNT_ID,
      population: options.population ?? 'seller',
      ...((options.population ?? 'seller') === 'seller'
        ? { sellerId: options.sessionSellerId ?? SELLER_ID }
        : {}),
      transport: 'cookie',
      lifetime: LIFETIME,
      now: T0,
    });
    const session: Session =
      options.actingAs === undefined
        ? opened
        : ({ ...opened, actingAs: options.actingAs } as unknown as Session);
    await fakes.sessionRepository.add(market, session, new Uint8Array([1]));
    const unitOfWork = {
      run: async <T, E>(
        _m: MarketContext,
        work: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
      ) => work(),
    } as unknown as UnitOfWork;
    const accounts = {
      findById: () =>
        Promise.resolve({
          state: options.account ?? { population: 'seller', status: 'active' },
        }),
    } as unknown as AccountRepository;
    const memberships = {
      findActiveByAccount: () =>
        Promise.resolve(
          options.membership === null
            ? null
            : { state: options.membership ?? { state: 'active', sellerId: SELLER_ID } },
        ),
    } as unknown as SellerMembershipRepository;
    const resolver = new SellerJobIdentityResolver({
      unitOfWork,
      accounts,
      sessions: fakes.sessionRepository,
      memberships,
    });
    const resume = () =>
      resolver.resumeSeller(market, {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        sellerId: SELLER_ID,
      });
    const revoke = (reason: SessionRevokedReason | null) =>
      fakes.sessionRepository.revoke(
        market,
        SESSION_ID,
        ACCOUNT_ID,
        reason as never,
        T0.add({ seconds: 60 }),
      );
    return { fakes, resume, revoke };
  }

  it('resumes the account as a seller actor of that seller, holding no permission', async () => {
    const { resume } = await rig();
    expect(await resume()).toMatchObject({
      kind: 'authenticated',
      population: 'seller',
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      sellerId: SELLER_ID,
    });
  });

  it('walks every revocation reason: only a sign-out lets the job go on', async () => {
    expect(new Set(Object.keys(JOB_CONTINUES))).toEqual(new Set(SESSION_REVOKED_REASONS));
    for (const reason of SESSION_REVOKED_REASONS) {
      const { resume, fakes } = await rig();
      // Revoke it directly in the store, as the flow for that reason would.
      await fakes.sessionRepository.revoke(
        market,
        SESSION_ID,
        ACCOUNT_ID,
        reason,
        T0.add({ seconds: 60 }),
      );
      const actor = await resume();
      expect([reason, actor !== null]).toEqual([reason, JOB_CONTINUES[reason]]);
    }
    expect([...SESSION_REASONS_THAT_LEAVE_JOBS]).toEqual(['sign-out']);
  });

  it('lets the job go on for a session that was never revoked (expiry or idleness)', async () => {
    const { resume } = await rig();
    expect(await resume()).not.toBeNull();
  });

  it('stops the job for a revocation with a missing reason (fail closed)', async () => {
    const { fakes, resume } = await rig();
    const stored = (await fakes.sessionRepository.findById(market, SESSION_ID)) as Session;
    const spy = jest.spyOn(fakes.sessionRepository, 'findById');
    spy.mockResolvedValue({ ...stored, revokedAt: T0, revokedReason: null } as Session);
    expect(await resume()).toBeNull();
    spy.mockResolvedValue({ ...stored, revokedAt: T0, revokedReason: 'something-new' } as never);
    expect(await resume()).toBeNull();
  });

  it('keeps the job going after a sign-out and stops it when the seller is suspended', async () => {
    // The realistic suspension: the sessions of the seller's members are revoked with the reason
    // `seller-suspended`; the resolver answers null (the run then asks the seller's own state).
    const { revoke, resume } = await rig();
    expect(await revoke('sign-out')).toBe(true);
    expect(await resume()).not.toBeNull();
    const suspended = await rig();
    await suspended.revoke('seller-suspended');
    expect(await suspended.resume()).toBeNull();
  });

  it.each(ACCOUNT_BULK_REASONS)(
    'stops after: start, sign out, then a bulk revocation for %s',
    async (reason) => {
      const { fakes, resume, revoke } = await rig();
      await revoke('sign-out');
      await fakes.sessionRepository.revokeAllOf(
        market,
        ACCOUNT_ID,
        reason,
        T0.add({ seconds: 120 }),
        OTHER_SESSION_ID,
      );
      expect(await resume()).toBeNull();
    },
  );

  it("keeps another account's bulk end, and one from before the session began, from stopping it", async () => {
    const { fakes, resume, revoke } = await rig();
    await revoke('sign-out');
    await fakes.sessionRepository.revokeAllOf(
      market,
      OTHER_ACCOUNT_ID,
      'password-reset',
      T0.add({ seconds: 120 }),
      null,
    );
    expect(await resume()).not.toBeNull();
    fakes.sessionsInvalidatedAt.set(ACCOUNT_ID, T0.subtract({ seconds: 3600 }));
    expect(await resume()).not.toBeNull();
  });

  it('stops when the account left the seller (team removal)', async () => {
    expect(await (await rig({ membership: null })).resume()).toBeNull();
    expect(
      await (await rig({ membership: { state: 'removed', sellerId: SELLER_ID } })).resume(),
    ).toBeNull();
    // An active membership of another seller is not this seller's.
    expect(
      await (await rig({ membership: { state: 'active', sellerId: OTHER_SELLER_ID } })).resume(),
    ).toBeNull();
  });

  it('stops when the account is disabled or is not a seller account', async () => {
    expect(
      await (await rig({ account: { population: 'seller', status: 'disabled' } })).resume(),
    ).toBeNull();
    expect(
      await (await rig({ account: { population: 'admin', status: 'active' } })).resume(),
    ).toBeNull();
  });

  it('never resumes an acting-as (Login as Seller) session', async () => {
    const { resume } = await rig({ actingAs: { adminAccountId: OTHER_ACCOUNT_ID } });
    expect(await resume()).toBeNull();
    // An empty marker is not a marker.
    expect(await (await rig({ actingAs: null })).resume()).not.toBeNull();
  });

  it("refuses another seller's session and a session of another population", async () => {
    expect(await (await rig({ sessionSellerId: OTHER_SELLER_ID })).resume()).toBeNull();
    expect(await (await rig({ population: 'admin' })).resume()).toBeNull();
  });

  it('refuses an unknown session and a session of another account', async () => {
    const { fakes } = await rig();
    const resolver = new SellerJobIdentityResolver({
      unitOfWork: {
        run: async <T, E>(
          _m: MarketContext,
          work: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
        ) => work(),
      } as unknown as UnitOfWork,
      accounts: {
        findById: () => Promise.resolve({ state: { population: 'seller', status: 'active' } }),
      } as unknown as AccountRepository,
      sessions: fakes.sessionRepository,
      memberships: {
        findActiveByAccount: () =>
          Promise.resolve({ state: { state: 'active', sellerId: SELLER_ID } }),
      } as unknown as SellerMembershipRepository,
    });
    expect(
      await resolver.resumeSeller(market, {
        accountId: ACCOUNT_ID,
        sessionId: OTHER_SESSION_ID,
        sellerId: SELLER_ID,
      }),
    ).toBeNull();
    expect(
      await resolver.resumeSeller(market, {
        accountId: OTHER_ACCOUNT_ID,
        sessionId: SESSION_ID,
        sellerId: SELLER_ID,
      }),
    ).toBeNull();
  });
});
