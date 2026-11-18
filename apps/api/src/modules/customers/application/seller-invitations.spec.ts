import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import {
  decideAttribution,
  decideClaim,
  normalizeInviteToken,
  type InvitationRules,
  type SellerAttribution,
} from '../domain/seller-invitations';
import { ConfigInvitationRules } from '../infrastructure/config-invitation-rules';
import { RandomInviteTokens } from '../infrastructure/random-invite-tokens';
import type { InvitationPeers } from './ports/invitation-peers';
import { exclusiveSellerOf, type InvitationDependencies } from './seller-invitations-flow';
import {
  RecordingAudit,
  RecordingOutbox,
  RecordingStepUp,
} from './testing/in-memory-account-deletion';
import { InMemoryReadModels } from './testing/in-memory-read-models';
import {
  InMemoryInviteLinks,
  InMemorySellerAttributions,
  ScriptedInviteTokens,
} from './testing/in-memory-seller-invitations';
import { AdminSellerAttributionsDecide } from './use-cases/admin-seller-attributions-decide.use-case';
import { AdminSellerAttributionsExport } from './use-cases/admin-seller-attributions-export.use-case';
import { AdminSellerAttributionsIds } from './use-cases/admin-seller-attributions-ids.use-case';
import { AdminSellerAttributionsList } from './use-cases/admin-seller-attributions-list.use-case';
import { JoinStoreByInvitation } from './use-cases/join-store-by-invitation.use-case';
import { ReadExclusiveSeller } from './use-cases/read-exclusive-seller.use-case';
import { ResolveStoreInvitation } from './use-cases/resolve-store-invitation.use-case';
import { SellerInviteLinkRefresh } from './use-cases/seller-invite-link-refresh.use-case';
import { SellerInviteLinkView } from './use-cases/seller-invite-link-view.use-case';
import { ViewOwnStoreInvitation } from './use-cases/view-own-store-invitation.use-case';

// Sellers' invite links and the exclusive customer (customers management phase 4a) on both Market
// fixtures: a seller's team draws the shop's link (a refresh revokes the old one, audited); the
// storefront resolves a token to the store's address only; a newly signed-up customer claims it
// once (an old account, one with orders or one attributed already is refused and nothing is kept;
// a member of the store's own team is recorded as rejected); a burst through one link is flagged;
// the admin reads the attributions (suspicious first), rejects and restores them, and exports them
// behind the step-up.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-16T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SHOP = id<'Seller'>(0x51);
const RIVAL = id<'Seller'>(0x52);
const TOKEN_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
const TOKEN_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCC';

const failure = (result: Result<unknown, { code: string }>) =>
  result.ok ? 'ok' : result.error.code;

describe('invite link rules', () => {
  const rules: InvitationRules = { signUpWindowDays: 7, burstPerDay: 3 };
  const facts = {
    now: T0,
    signedUpAt: T0.subtract({ hours: 1 }),
    orderCount: 0,
    attributed: false,
    sellerTeam: false,
    sellerLastDay: 0,
  };

  it('records a new sign-up, refuses an old, ordering or attributed one, flags a burst', () => {
    expect(decideClaim(facts, rules)).toEqual({
      kind: 'record',
      status: 'active',
      rejectReason: null,
      flags: [],
    });
    expect(decideClaim({ ...facts, attributed: true }, rules)).toEqual({ kind: 'refuse' });
    expect(decideClaim({ ...facts, orderCount: 1 }, rules)).toEqual({ kind: 'refuse' });
    expect(
      decideClaim({ ...facts, signedUpAt: T0.subtract({ hours: 7 * 24 + 1 }) }, rules),
    ).toEqual({ kind: 'refuse' });
    expect(
      decideClaim({ ...facts, signedUpAt: T0.subtract({ hours: 7 * 24 }) }, rules),
    ).toMatchObject({ kind: 'record' });
    expect(decideClaim({ ...facts, sellerLastDay: 3 }, rules)).toMatchObject({
      status: 'active',
      flags: ['link-burst'],
    });
    expect(decideClaim({ ...facts, sellerTeam: true }, rules)).toEqual({
      kind: 'record',
      status: 'rejected',
      rejectReason: 'seller-team',
      flags: [],
    });
  });

  it('rejects and restores by version; a seller-team rejection stays', () => {
    const admin = id<'Account'>(0xad);
    const base: SellerAttribution = {
      accountId: id<'Account'>(0xa1),
      sellerId: SHOP,
      linkId: id<'SellerInviteLink'>(0x11),
      attributedAt: T0,
      status: 'active',
      rejectReason: null,
      flags: [],
      decidedByAccountId: null,
      decidedAt: null,
      version: 1,
    };
    const rejected = decideAttribution(base, 'reject', admin, T0);
    expect(rejected).toEqual(
      ok(
        expect.objectContaining({
          status: 'rejected',
          rejectReason: 'admin',
          decidedByAccountId: admin,
          version: 2,
        }),
      ),
    );
    expect(decideAttribution(base, 'restore', admin, T0)).toEqual(ok('unchanged'));
    const restored = decideAttribution(
      rejected.ok ? (rejected.value as SellerAttribution) : base,
      'restore',
      admin,
      T0,
    );
    expect(restored).toEqual(
      ok(expect.objectContaining({ status: 'active', rejectReason: null, version: 3 })),
    );
    expect(
      decideAttribution(
        { ...base, status: 'rejected', rejectReason: 'seller-team' },
        'restore',
        admin,
        T0,
      ),
    ).toEqual(err('seller-team'));
  });

  it('reads a typed token back and draws tokens in the Crockford alphabet', () => {
    expect(normalizeInviteToken(` ${TOKEN_A.toLowerCase()} `)).toBe(TOKEN_A);
    expect(normalizeInviteToken('ABC')).toBeNull();
    expect(normalizeInviteToken('U'.repeat(26))).toBeNull();
    expect(normalizeInviteToken('A'.repeat(65))).toBeNull();
    expect(normalizeInviteToken(42)).toBeNull();
    const tokens = new RandomInviteTokens();
    for (let n = 0; n < 50; n += 1) expect(normalizeInviteToken(tokens.next())).not.toBeNull();
  });
});

class FakeInvitationPeers implements InvitationPeers {
  published = new Map<Id<'Seller'>, string>([
    [SHOP, 'shop'],
    [RIVAL, 'rival'],
  ]);
  team = new Set<string>();
  followed: { accountId: string; sellerId: Id<'Seller'> }[] = [];
  followFails = false;
  sellersDown = false;
  readonly identity = {
    ownAccountTiedToSeller: (context: CallContext, sellerId: Id<'Seller'>) => {
      const accountId = (context.actor as { accountId: string }).accountId;
      return Promise.resolve(ok(this.team.has(`${sellerId}:${accountId}`)));
    },
  };
  readonly engagement = {
    followStore: (context: CallContext, sellerId: Id<'Seller'>) => {
      if (this.followFails) return Promise.resolve(err({ code: 'engagement.unavailable' }));
      this.followed.push({
        accountId: (context.actor as { accountId: string }).accountId,
        sellerId,
      });
      return Promise.resolve(ok({ following: true }));
    },
  };
  readonly sellers = {
    publishedStoreSlugs: (_context: CallContext, sellerIds: readonly Id<'Seller'>[]) => {
      if (this.sellersDown) return Promise.resolve(err({ code: 'sellers.unavailable' }));
      const found = new Map<Id<'Seller'>, string>();
      for (const sellerId of sellerIds) {
        const slug = this.published.get(sellerId);
        if (slug !== undefined) found.set(sellerId, slug);
      }
      return Promise.resolve(ok(found as ReadonlyMap<Id<'Seller'>, string>));
    },
  };
}

describe.each(['AU', 'ZZ'] as const)('invite links in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const other: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const rules = markets.get(market.marketId).customers!.invitations!;
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  const seller = (sellerId: Id<'Seller'>, target = market): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'seller',
        accountId: id<'Account'>(0x5000 + Number(`0x${sellerId.slice(-2)}`)),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `invite-links-${code}-seller`,
    );
  const customer = (accountId: Id<'Account'>, target = market): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x63),
        sellerId: null,
      }),
      `invite-links-${code}-customer`,
    );
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id<'Account'>(0xad),
      sessionId: id<'Session'>(0x62),
      sellerId: null,
    }),
    `invite-links-${code}-admin`,
  );
  const anonymous = testCallContext(market, 'anonymous', `invite-links-${code}-anon`);

  let clock: FixedClock;
  let links: InMemoryInviteLinks;
  let attributions: InMemorySellerAttributions;
  let readModels: InMemoryReadModels;
  let audit: RecordingAudit;
  let outbox: RecordingOutbox;
  let stepUp: RecordingStepUp;
  let peers: FakeInvitationPeers;
  let deps: InvitationDependencies;
  let uc: ReturnType<typeof useCases>;
  let next = 0x100;

  const useCases = (d: InvitationDependencies) => ({
    view: new SellerInviteLinkView(gate, d),
    refresh: new SellerInviteLinkRefresh(gate, d),
    resolve: new ResolveStoreInvitation(gate, d),
    join: new JoinStoreByInvitation(gate, d),
    own: new ViewOwnStoreInvitation(gate, d),
    list: new AdminSellerAttributionsList(gate, d),
    ids: new AdminSellerAttributionsIds(gate, d),
    decide: new AdminSellerAttributionsDecide(gate, d),
    export: new AdminSellerAttributionsExport(gate, d),
  });

  /** A customer who signed up `hoursAgo` hours ago (in the directory). */
  const signUp = (hoursAgo = 1, email?: string, target = market): Id<'Account'> => {
    const accountId = id<'Account'>((next += 1));
    void readModels.upsertDirectory(target, {
      accountId,
      email: email ?? `c${next.toString(16)}@example.test`,
      displayName: `Customer ${next}`,
      status: 'active',
      emailVerified: true,
      signedUpAt: clock.now().subtract({ hours: hoursAgo }),
    });
    return accountId;
  };
  const drawLink = async (sellerId = SHOP): Promise<string> => {
    const drawn = await uc.refresh.execute(seller(sellerId), {});
    if (!drawn.ok || drawn.value.link === null) throw new Error('no link');
    return drawn.value.link.token;
  };
  const join = (accountId: Id<'Account'>, token: unknown, target = market) =>
    uc.join.execute(customer(accountId, target), { token });

  const chunksOf = async (chunks: AsyncIterable<string | Uint8Array>): Promise<string> => {
    let text = '';
    for await (const chunk of chunks) {
      text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    }
    return text;
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    links = new InMemoryInviteLinks();
    readModels = new InMemoryReadModels();
    attributions = new InMemorySellerAttributions(readModels.directory);
    audit = new RecordingAudit();
    outbox = new RecordingOutbox();
    stepUp = new RecordingStepUp();
    peers = new FakeInvitationPeers();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      inviteLinks: links,
      attributions,
      readModels,
      tokens: new ScriptedInviteTokens([TOKEN_A, TOKEN_B, TOKEN_C]),
      ids: new SequenceIdGenerator(clock),
      clock,
      audit,
      outbox,
      invitationPeers: peers,
      invitationRules: new ConfigInvitationRules(markets),
      stepUp,
      sheetWriter: {
        xlsx: async function* (_name, rows) {
          for await (const row of rows) yield new TextEncoder().encode(row.join('\t') + '\n');
        },
      },
    };
    uc = useCases(deps);
  });

  it('draws the shop link, revokes the old one on refresh and audits each draw', async () => {
    expect(await uc.view.execute(seller(SHOP), {})).toEqual(
      ok({ link: null, signups: { active: 0, rejected: 0 } }),
    );
    expect(await drawLink()).toBe(TOKEN_A);
    expect(await drawLink()).toBe(TOKEN_B);
    expect(links.rows.map((row) => [row.token, row.revokedAt?.toString() ?? null])).toEqual([
      [TOKEN_A, T0.toString()],
      [TOKEN_B, null],
    ]);
    expect(links.rows.filter((row) => row.revokedAt === null).map((row) => row.token)).toEqual([
      TOKEN_B,
    ]);
    expect(await uc.view.execute(seller(SHOP), {})).toMatchObject({
      ok: true,
      value: { link: { token: TOKEN_B, createdAt: T0.toString() } },
    });
    expect(audit.entries).toHaveLength(2);
    const [first, second] = audit.entries;
    expect(first).toMatchObject({ action: 'customers.seller-invite-link.drawn' });
    expect(second).toMatchObject({ targetId: links.rows[1]!.id });
    expect(JSON.stringify(second)).toContain(links.rows[0]!.id);
    // A rival shop sees only its own (no link yet); a customer or an admin is refused.
    expect(await uc.view.execute(seller(RIVAL), {})).toMatchObject({
      value: { link: null },
    });
    expect(failure(await uc.view.execute(customer(id<'Account'>(0xa1)), {}))).toBe('access.denied');
    expect(failure(await uc.refresh.execute(admin, {}))).toBe('access.denied');
  });

  it('draws again when a token is taken, in this Market only', async () => {
    deps = { ...deps, tokens: new ScriptedInviteTokens([TOKEN_A, TOKEN_A, TOKEN_C]) };
    uc = useCases(deps);
    expect(await drawLink(SHOP)).toBe(TOKEN_A);
    expect(await drawLink(RIVAL)).toBe(TOKEN_C);
    // The same token in the other Market is free.
    const elsewhere = useCases({ ...deps, tokens: new ScriptedInviteTokens([TOKEN_A]) });
    const drawn = await elsewhere.refresh.execute(seller(SHOP, other), {});
    expect(drawn).toMatchObject({ ok: true, value: { link: { token: TOKEN_A } } });
  });

  it('resolves a live token to the store address only, anonymously', async () => {
    const token = await drawLink();
    expect(await uc.resolve.execute(anonymous, { token: token.toLowerCase() })).toEqual(
      ok({ slug: 'shop' }),
    );
    expect(failure(await uc.resolve.execute(anonymous, { token: 'nope' }))).toBe(
      'customers.invitation-not-found',
    );
    expect(failure(await uc.resolve.execute(anonymous, { token: TOKEN_C }))).toBe(
      'customers.invitation-not-found',
    );
    // In the other Market the token means nothing.
    const otherAnonymous = testCallContext(other, 'anonymous', 'other-anon-abcd');
    expect(failure(await uc.resolve.execute(otherAnonymous, { token }))).toBe(
      'customers.invitation-not-found',
    );
    await drawLink();
    expect(failure(await uc.resolve.execute(anonymous, { token }))).toBe(
      'customers.invitation-not-found',
    );
    // A store the public cannot see now (suspended, unpublished) is the same answer.
    peers.published.delete(SHOP);
    expect(failure(await uc.resolve.execute(anonymous, { token: TOKEN_B }))).toBe(
      'customers.invitation-not-found',
    );
  });

  it('records a new customer, follows the store, sends the event, and shows the store to them', async () => {
    const token = await drawLink();
    const alice = signUp(2);
    expect(await join(alice, token)).toEqual(ok({ slug: 'shop', following: true }));
    expect(attributions.rows).toEqual([
      expect.objectContaining({
        marketId: market.marketId,
        accountId: alice,
        sellerId: SHOP,
        status: 'active',
        rejectReason: null,
        flags: [],
        version: 1,
        attributedAt: T0,
      }),
    ]);
    expect(peers.followed).toEqual([{ accountId: alice, sellerId: SHOP }]);
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: 'customers.seller-attribution-changed.v1',
        payload: { accountId: alice, sellerId: SHOP, status: 'active' },
      }),
    ]);
    expect(await uc.own.execute(customer(alice), {})).toEqual(
      ok({ store: { sellerId: SHOP, slug: 'shop', joinedAt: T0.toString() } }),
    );
    expect(await uc.view.execute(seller(SHOP), {})).toMatchObject({
      value: { signups: { active: 1, rejected: 0 } },
    });
    const since = await exclusiveSellerOf(deps, customer(alice), alice, T0.add({ hours: 1 }));
    expect(since).toEqual(ok({ sellerId: SHOP, since: T0 }));
    expect(
      await exclusiveSellerOf(deps, customer(alice), alice, T0.subtract({ hours: 1 })),
    ).toEqual(ok(null));
  });

  it('answers the exclusive seller to the system actor only (customers.read-exclusive-seller)', async () => {
    const token = await drawLink();
    const alice = signUp();
    await join(alice, token);
    const read = new ReadExclusiveSeller(gate, deps);
    const system = testCallContext(market, 'system', `invite-links-${code}-system`);
    expect(await read.execute(system, { accountId: alice, at: T0.add({ hours: 1 }) })).toEqual(
      ok({ sellerId: SHOP, since: T0 }),
    );
    expect(await read.execute(system, { accountId: id<'Account'>(0xbeef), at: T0 })).toEqual(
      ok(null),
    );
    expect(
      await read.execute(system, { accountId: 'nope' as Id<'Account'>, at: T0 }),
    ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(
      await read.execute(system, {
        accountId: alice,
        at: T0.toString() as unknown as Temporal.Instant,
      }),
    ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await read.execute(customer(alice), { accountId: alice, at: T0 })).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('keeps the attribution when the follow fails', async () => {
    const token = await drawLink();
    peers.followFails = true;
    const alice = signUp();
    expect(await join(alice, token)).toEqual(ok({ slug: 'shop', following: false }));
    expect(attributions.rows).toHaveLength(1);
  });

  it('refuses an account attributed already, an old account, and one with orders; nothing is kept', async () => {
    const token = await drawLink();
    const alice = signUp();
    await join(alice, token);
    const rivalToken = await drawLink(RIVAL);
    expect(failure(await join(alice, rivalToken))).toBe('customers.invitation-not-eligible');

    const old = signUp(rules.signUpWindowDays * 24 + 1);
    expect(failure(await join(old, token))).toBe('customers.invitation-not-eligible');

    const buyer = signUp();
    await readModels.ensureStats(market, buyer);
    const stats = (await readModels.findStats(market, buyer))!;
    await readModels.upsertStats(market, { ...stats, orderCount: 1 });
    expect(failure(await join(buyer, token))).toBe('customers.invitation-not-eligible');

    expect(attributions.rows.map((row) => row.accountId)).toEqual([alice]);
    expect(outbox.events).toHaveLength(1);
    expect(peers.followed).toHaveLength(1);
  });

  it('records a member of the store team as rejected and refuses the claim', async () => {
    const token = await drawLink();
    const staff = signUp(1, 'staff@shop.example');
    peers.team.add(`${SHOP}:${staff}`);
    expect(failure(await join(staff, token))).toBe('customers.invitation-not-eligible');
    expect(attributions.rows).toEqual([
      expect.objectContaining({
        accountId: staff,
        status: 'rejected',
        rejectReason: 'seller-team',
      }),
    ]);
    expect(peers.followed).toEqual([]);
    expect(outbox.events).toEqual([
      expect.objectContaining({
        payload: { accountId: staff, sellerId: SHOP, status: 'rejected' },
      }),
    ]);
    expect(await uc.own.execute(customer(staff), {})).toEqual(ok({ store: null }));
    // The rejection stands: an admin cannot restore it.
    const restore = await uc.decide.execute(admin, { decision: 'restore', accountIds: [staff] });
    expect(restore).toEqual(
      ok({ results: [{ accountId: staff, outcome: 'seller-team', status: 'rejected' }] }),
    );
  });

  it('flags a burst through one link at the Market threshold', async () => {
    const token = await drawLink();
    const joined: Id<'Account'>[] = [];
    for (let n = 0; n <= rules.burstPerDay; n += 1) {
      const accountId = signUp();
      joined.push(accountId);
      expect(await join(accountId, token)).toMatchObject({ ok: true });
    }
    const flagged = attributions.rows.filter((row) => row.flags.includes('link-burst'));
    expect(flagged.map((row) => row.accountId)).toEqual([joined[joined.length - 1]]);
    // A day later the window is clear again.
    clock.set(T0.add({ hours: 25 }));
    const later = signUp();
    await join(later, token);
    expect(attributions.rows.find((row) => row.accountId === later)?.flags).toEqual([]);
  });

  it('counts the burst per seller, so a refresh does not reset it', async () => {
    let token = await drawLink();
    const joined: Id<'Account'>[] = [];
    for (let n = 0; n <= rules.burstPerDay; n += 1) {
      // A new link before every claim: the count follows the seller, not the link.
      if (n > 0) token = await drawLink();
      const accountId = signUp();
      joined.push(accountId);
      expect(await join(accountId, token)).toMatchObject({ ok: true });
    }
    const flagged = attributions.rows.filter((row) => row.flags.includes('link-burst'));
    expect(flagged.map((row) => row.accountId)).toEqual([joined[joined.length - 1]]);
  });

  it('refuses a Login-as session on every route', async () => {
    const actingAs = { actingAs: { adminAccountId: id<'Account'>(0xad) } };
    const as = (context: CallContext): CallContext => ({
      ...context,
      actor: { ...context.actor, ...actingAs },
    });
    const token = await drawLink();
    const alice = signUp();
    expect(failure(await uc.view.execute(as(seller(SHOP)), {}))).toBe('access.denied');
    expect(failure(await uc.refresh.execute(as(seller(SHOP)), {}))).toBe('access.denied');
    expect(failure(await uc.join.execute(as(customer(alice)), { token }))).toBe('access.denied');
    expect(failure(await uc.own.execute(as(customer(alice)), {}))).toBe('access.denied');
    expect(failure(await uc.list.execute(as(admin), {}))).toBe('access.denied');
    expect(
      failure(await uc.decide.execute(as(admin), { decision: 'reject', accountIds: [alice] })),
    ).toBe('access.denied');
    expect(failure(await uc.export.execute(as(admin), {}))).toBe('access.denied');
    expect(attributions.rows).toEqual([]);
  });

  it('refuses a revoked link, a hidden store, a malformed body, other actors and other Markets', async () => {
    const token = await drawLink();
    const alice = signUp();
    await drawLink();
    expect(failure(await join(alice, token))).toBe('customers.invitation-not-found');
    peers.published.delete(SHOP);
    expect(failure(await join(alice, TOKEN_B))).toBe('customers.invitation-not-found');
    peers.published.set(SHOP, 'shop');
    expect(
      failure(await uc.join.execute(customer(alice), { token: TOKEN_B, sellerId: SHOP })),
    ).toBe('validation.failed');
    expect(failure(await join(alice, 'x'))).toBe('validation.failed');
    expect(failure(await uc.join.execute(seller(SHOP), { token: TOKEN_B }))).toBe('access.denied');
    expect(failure(await uc.join.execute(admin, { token: TOKEN_B }))).toBe('access.denied');
    const elsewhere = signUp(1, undefined, other);
    expect(failure(await join(elsewhere, TOKEN_B, other))).toBe('customers.invitation-not-found');
    peers.sellersDown = true;
    expect(failure(await join(alice, TOKEN_B))).toBe('customers.unavailable');
    expect(attributions.rows).toEqual([]);
  });

  it('asks again while the directory has no row for a new account', async () => {
    const token = await drawLink();
    expect(failure(await join(id<'Account'>(0xfff), token))).toBe('customers.unavailable');
    expect(attributions.rows).toEqual([]);
  });

  describe('the admin list', () => {
    let alice: Id<'Account'>;
    let bob: Id<'Account'>;
    let staff: Id<'Account'>;

    beforeEach(async () => {
      const shopToken = await drawLink(SHOP);
      const rivalToken = await drawLink(RIVAL);
      alice = signUp(1, 'alice@example.test');
      await join(alice, shopToken);
      clock.set(T0.add({ hours: 1 }));
      bob = signUp(1, 'bob@example.test');
      await join(bob, rivalToken);
      clock.set(T0.add({ hours: 2 }));
      staff = signUp(1, 'staff@example.test');
      peers.team.add(`${SHOP}:${staff}`);
      await join(staff, shopToken);
    });

    it('opens on the suspicious view with every view counted', async () => {
      const listed = await uc.list.execute(admin, {});
      expect(listed).toMatchObject({
        ok: true,
        value: {
          items: [{ accountId: staff, email: 'staff@example.test', rejectReason: 'seller-team' }],
          counts: { suspicious: 1, all: 3, active: 2, rejected: 1 },
          paging: null,
          nextCursor: null,
        },
      });
      const all = await uc.list.execute(admin, { view: 'all', page: 1, pageSize: 2 });
      expect(all).toMatchObject({
        ok: true,
        value: { paging: { total: 3, page: 1, pageSize: 2 } },
      });
      expect(all.ok && all.value.items.map((row) => row.accountId)).toEqual([staff, bob]);
      const oldest = await uc.list.execute(admin, { view: 'all', direction: 'asc', limit: 1 });
      expect(oldest).toMatchObject({ ok: true, value: { nextCursor: 'o1' } });
      expect(oldest.ok && oldest.value.items.map((row) => row.accountId)).toEqual([alice]);
    });

    it('searches by email and filters by seller, status and day', async () => {
      const ids = (input: object) =>
        uc.list
          .execute(admin, { view: 'all', ...input })
          .then((r) => (r.ok ? r.value.items.map((row) => row.accountId) : r.error.code));
      expect(await ids({ q: 'BO' })).toEqual([bob]);
      expect(await ids({ filters: { sellerId: SHOP } })).toEqual([staff, alice]);
      expect(await ids({ filters: { status: 'active', sellerId: SHOP } })).toEqual([alice]);
      expect(await ids({ filters: { rejectReason: 'seller-team' } })).toEqual([staff]);
      expect(await ids({ filters: { attributedFrom: '2026-11-17' } })).toEqual([]);
      expect(await ids({ filters: { attributedTo: '2026-11-16' } })).toHaveLength(3);
      expect(await ids({ filters: { email: 'x' } })).toBe('validation.failed');
      expect(
        await ids({ filters: { attributedFrom: '2026-11-17', attributedTo: '2026-11-16' } }),
      ).toBe('validation.failed');
      expect(await ids({ q: 'a' })).toBe('validation.failed');
      expect(await ids({ sort: 'email' })).toBe('validation.failed');
    });

    it('is the admin’s only and reads this Market only', async () => {
      expect(failure(await uc.list.execute(seller(SHOP), {}))).toBe('access.denied');
      expect(failure(await uc.list.execute(customer(alice), {}))).toBe('access.denied');
      const otherAdmin = testCallContext(
        other,
        testAuthenticatedActor(other, {
          population: 'admin',
          accountId: id<'Account'>(0xae),
          sessionId: id<'Session'>(0x64),
          sellerId: null,
        }),
        'other-admin',
      );
      expect(await uc.list.execute(otherAdmin, { view: 'all' })).toMatchObject({
        ok: true,
        value: { items: [], counts: { all: 0 } },
      });
    });

    it('selects all matching ids', async () => {
      expect(await uc.ids.execute(admin, { view: 'active' })).toMatchObject({
        ok: true,
        value: { ids: [bob, alice] },
      });
    });

    it('rejects and restores in bulk, audited, with events, and reports each account', async () => {
      const decided = await uc.decide.execute(admin, {
        decision: 'reject',
        accountIds: [alice, bob, staff, id<'Account'>(0xdead)],
      });
      expect(
        decided.ok &&
          [...decided.value.results].sort((a, b) => a.accountId.localeCompare(b.accountId)),
      ).toEqual(
        [
          { accountId: alice, outcome: 'changed', status: 'rejected' },
          { accountId: bob, outcome: 'changed', status: 'rejected' },
          { accountId: staff, outcome: 'unchanged', status: 'rejected' },
          { accountId: id<'Account'>(0xdead), outcome: 'not-found', status: null },
        ].sort((a, b) => a.accountId.localeCompare(b.accountId)),
      );
      const decisions = audit.entries.filter(
        (e) => e.action === 'customers.seller-attribution.decided',
      );
      expect(decisions).toHaveLength(2);
      expect(JSON.stringify(decisions)).not.toContain('@');
      expect(await uc.own.execute(customer(alice), {})).toEqual(ok({ store: null }));
      expect(await uc.list.execute(admin, {})).toMatchObject({
        value: { counts: { suspicious: 3, active: 0, rejected: 3 } },
      });

      const restored = await uc.decide.execute(admin, { decision: 'restore', accountIds: [alice] });
      expect(restored).toEqual(
        ok({ results: [{ accountId: alice, outcome: 'changed', status: 'active' }] }),
      );
      expect(attributions.rows.find((row) => row.accountId === alice)).toMatchObject({
        status: 'active',
        version: 3,
        decidedByAccountId: id<'Account'>(0xad),
      });
      expect(outbox.events.at(-1)).toMatchObject({
        payload: { accountId: alice, status: 'active' },
        aggregateVersion: 3,
      });
      expect(
        failure(await uc.decide.execute(admin, { decision: 'approve', accountIds: [alice] })),
      ).toBe('validation.failed');
      expect(failure(await uc.decide.execute(admin, { decision: 'reject', accountIds: [] }))).toBe(
        'validation.failed',
      );
      expect(
        failure(await uc.decide.execute(seller(SHOP), { decision: 'reject', accountIds: [alice] })),
      ).toBe('access.denied');
    });

    it('refuses the whole decision when another moved a row meanwhile', async () => {
      const update = attributions.update.bind(attributions);
      attributions.update = (m, a, v) =>
        a.accountId === bob ? Promise.resolve(false) : update(m, a, v);
      expect(
        failure(await uc.decide.execute(admin, { decision: 'reject', accountIds: [alice, bob] })),
      ).toBe('customers.unavailable');
    });

    it('exports behind the step-up, audited without personal data', async () => {
      const csv = await uc.export.execute(admin, { view: 'all' });
      if (!csv.ok) throw new Error(csv.error.code);
      expect(csv.value.filename).toBe(
        `seller-attributions-${T0.add({ hours: 2 }).toString().slice(0, 10)}.csv`,
      );
      const text = await chunksOf(csv.value.chunks);
      expect(text.startsWith('﻿')).toBe(true);
      expect(text).toContain('alice@example.test');
      expect(text.trim().split('\n')).toHaveLength(4);
      expect(stepUp.asked).toEqual([CUSTOMERS_EXPORT_STEP_UP]);
      const exported = audit.entries.filter(
        (e) => e.action === 'customers.seller-attributions.exported',
      );
      expect(exported).toHaveLength(1);
      expect(JSON.stringify(exported)).not.toContain('@example.test');
      expect(JSON.stringify(exported)).toContain('"rowCount":3');

      const named = await uc.export.execute(admin, {
        format: 'xlsx',
        ids: [bob, id<'Account'>(0xdead)],
      });
      if (!named.ok) throw new Error(named.error.code);
      const sheet = await chunksOf(named.value.chunks);
      expect(sheet).toContain('bob@example.test');
      expect(sheet).not.toContain('alice@example.test');

      stepUp.answer = err({ code: 'second-factor.required', actionKey: CUSTOMERS_EXPORT_STEP_UP });
      expect(await uc.export.execute(admin, {})).toEqual(
        err({ code: 'second-factor.required', actionKey: CUSTOMERS_EXPORT_STEP_UP }),
      );
      expect(
        audit.entries.filter((e) => e.action === 'customers.seller-attributions.exported'),
      ).toHaveLength(2);
      expect(failure(await uc.export.execute(admin, { format: 'pdf' }))).toBe('validation.failed');
      expect(failure(await uc.export.execute(seller(SHOP), {}))).toBe('access.denied');
    });

    it('drops a customer whose directory row is gone', async () => {
      attributions.removeAccount(market, alice);
      readModels.directory.delete(`${market.marketId}:${alice}`);
      expect(await uc.list.execute(admin, { view: 'all' })).toMatchObject({
        value: { counts: { all: 2 } },
      });
    });
  });
});
