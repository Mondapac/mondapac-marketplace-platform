import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from '../src/modules/identity/application/ports/identity-market-policy';
import {
  LINK_TARGETS,
  type LinkTargets,
} from '../src/modules/identity/application/ports/link-secrets';
import {
  SELLER_ACCESS_CONTRACT,
  type SellerAccessContract,
} from '../src/modules/identity/contracts/seller-access.contract';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from '../src/modules/identity/application/use-cases/send-invitation-mail.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { SendSellerAccessMail } from '../src/modules/identity/application/use-cases/send-seller-access-mail.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { MarketConfigIdentityPolicy } from '../src/modules/identity/infrastructure/market-config-identity-policy';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin seller routes and the invited owner's acceptance over HTTP (identity design 3.3,
// 3.4, 5.2, 8.1, 9; `ux.md` E4 to E7, F8; slice 9): the real guards, controllers and use cases,
// with identity's database ports and the mail transport as in-memory fakes. Sellers sign up
// through the seller routes; admin sessions are seeded into the fake store. nestjs-pino captures
// the log lines of a file's first application only, so the logging test comes first.

const START = Temporal.Now.instant();
const PASSWORD = 'correct horse battery staple';
const OWNER_EMAIL = 'Owner@Example.com';
const INVITEE = 'Invited.Owner@Example.com';
const NAME = 'Amina Rahman';
const REASON = 'Canary reason: licence number does not match';
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
/** The seller accept page each Market file configures (`identity.links.targets.seller`). */
const ACCEPT_PAGES: Readonly<Record<string, string>> = {
  AU: 'https://seller.au.mondapac.test/accept-invitation',
  ZZ: 'https://seller.zz.test/konto/einladung',
};

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
/** Per-Market fixture ids, so both Markets can hold fixtures in one test. */
const offsetOf = (code: string) => (code === 'AU' ? 0 : 0x100);
const rootOf = (code: string) =>
  id<'Account'>(`01990000-0000-7000-8000-${n12(0xa001 + offsetOf(code))}`);
const viewerOf = (code: string) =>
  id<'Account'>(`01990000-0000-7000-8000-${n12(0xa002 + offsetOf(code))}`);
const staffOf = (code: string) =>
  id<'Account'>(`01990000-0000-7000-8000-${n12(0xa003 + offsetOf(code))}`);
const STAFF_EMAIL = 'staff@seller.example';
const MISSING = '01990000-0000-7000-8000-00000000ffff';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let deliveries = 0;

/** The real link targets of a Market that configures no seller accept page (fail closed). */
function withoutSellerAcceptPage(markets: MarketRegistry): LinkTargets {
  const base = new MarketConfigIdentityPolicy(markets);
  return {
    target: (market: MarketContext, population, page) =>
      population === 'seller' && page === 'accept-invitation'
        ? null
        : base.target(market, population, page),
  };
}

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('admin seller routes over HTTP (integration, slice 9)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot(
    options: { readonly withoutAcceptPage?: boolean; readonly withoutReapplyLimit?: boolean } = {},
  ) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) => {
        let built = fakes.override(builder);
        if (options.withoutAcceptPage === true) {
          built = built
            .overrideProvider(LINK_TARGETS)
            .useFactory({ factory: withoutSellerAcceptPage, inject: [MarketRegistry] });
        }
        if (options.withoutReapplyLimit === true) {
          // A Market that configures no re-apply limit (fail closed); the real files carry 3.
          built = built.overrideProvider(IDENTITY_MARKET_POLICY).useFactory({
            factory: (markets: MarketRegistry): IdentityMarketPolicy =>
              Object.assign(
                Object.create(new MarketConfigIdentityPolicy(markets)) as IdentityMarketPolicy,
                { sellerReapplyLimit: () => null },
              ),
            inject: [MarketRegistry],
          });
        }
        return built;
      },
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const systemOf = (code: string) => testCallContext(marketOf(code), 'system', 'admin-sell-0001');
  const delivery = (subscriber: string) => ({
    eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
    subscriber,
    attempt: 1,
  });
  const roleOf = (seedCode: string, code: string, scope = 'platform') =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
    )!.id;

  const adminPost = (code: string, path: string, body: unknown, headers: Record<string, string>) =>
    http()
      .post(`/identity/admin/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);
  const sellerPost = (
    code: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    http()
      .post(`/identity/seller/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
      .send(body as object);

  /** The roles and two admins (Platform Administrator, Viewer) of the Market. */
  async function seeded(code: string) {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const marketId = code as AccountState['marketId'];
    for (const [n, accountId, seedCode] of [
      [1, rootOf(code), 'platform-administrator'],
      [2, viewerOf(code), 'viewer'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
        displayName: `Admin ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + offsetOf(code) + n)}`),
        marketId,
        accountId,
        roleId: roleOf(seedCode, code),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
  }

  /** An admin session of `account`, stored as a sign-in would; answers its headers. */
  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + offsetOf(code) + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: Temporal.Now.instant(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  /**
   * The root admin's decision through the seller-access contract, as `sellers`' review makes it
   * (sellers slice 7a-decide moved approve and reject off this controller; ADR-0022 decision 4).
   * The root's session must be open (`sessionOf(code, rootOf(code), 1)`).
   */
  const BASIS = id<'BusinessFileRevision'>('01990000-0000-7000-8000-00000000bb01');
  function decide(code: string, sellerId: Id<'Seller'>, decision: 'approve' | 'reject') {
    const admin = testCallContext(
      marketOf(code),
      testAuthenticatedActor(marketOf(code), {
        population: 'admin',
        accountId: rootOf(code),
        sessionId: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + offsetOf(code) + 1)}`),
        sellerId: null,
      }),
    );
    const contract = app.get<SellerAccessContract>(SELLER_ACCESS_CONTRACT, { strict: false });
    return decision === 'approve'
      ? contract.approveSellerAccess(admin, sellerId, BASIS)
      : contract.rejectSellerAccess(admin, sellerId, REASON, BASIS);
  }

  /** A self-registered seller waiting for approval, with its owner's session cookie. */
  async function pendingSeller(code: string) {
    await sellerPost(code, 'sign-up', {
      displayName: NAME,
      email: OWNER_EMAIL,
      password: PASSWORD,
    });
    const event = fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id };
    await app.get(SendLinkMail).execute(systemOf(code), {
      delivery: delivery('identity.link-mail'),
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: 'verify-email',
      aggregateVersion: event.aggregateVersion,
    });
    const token = /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    const confirmed = await sellerPost(code, 'confirm-email', { token, password: PASSWORD });
    expect(confirmed.status).toBe(200);
    const [seller] = [...fakes.sellerAccess.values()].filter((a) => a.marketId === code);
    // ZZ approves on sign-up; both Markets start these tests from "waiting for approval".
    fakes.seedSellerAccess({ ...seller!, state: 'pending' });
    return { sellerId: seller!.sellerId, cookie: cookieOf(confirmed.headers['set-cookie']) };
  }

  /** A staff member (Store Manager) of the seller, with a password: it can sign in. */
  function staffMember(code: string, sellerId: string) {
    const marketId = code as AccountState['marketId'];
    fakes.seedAccount({
      id: staffOf(code),
      marketId,
      population: 'seller',
      email: { typed: STAFF_EMAIL, normalized: STAFF_EMAIL },
      displayName: 'Staff Member',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(`01990000-0000-7000-8000-${n12(0xd100 + offsetOf(code))}`),
      marketId,
      accountId: staffOf(code),
      sellerId: sellerId as Id<'Seller'>,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe1f0 + offsetOf(code))}`),
      marketId,
      accountId: staffOf(code),
      roleId: roleOf('store-manager', code, 'seller'),
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
  }

  /** Runs the result mail of the last decision event; answers the mail. */
  async function decisionMailed(code: string) {
    const event = fakes.events.filter((e) => e.type.startsWith('identity.seller-access-')).at(-1)!;
    const decision = /identity\.seller-access-(\w+)\.v1/.exec(event.type)![1] as
      'approved' | 'rejected' | 'suspended' | 'reinstated';
    const payload = event.payload as { sellerId: Id; decisionId: Id };
    const sent = await app.get(SendSellerAccessMail).execute(systemOf(code), {
      delivery: delivery(`identity.seller-${decision}-mail`),
      sellerId: payload.sellerId,
      decisionId: payload.decisionId,
      decision,
    });
    expect(sent).toEqual({ ok: true, value: { code: 'seller-access-mail.sent' } });
    return fakes.mails.at(-1)!;
  }

  /** Runs the invitation mail of the last issued invitation; answers the token it carried. */
  async function invitationMailed(code: string): Promise<string> {
    const event = fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1').at(-1)!;
    const sent = await app.get(SendInvitationMail).execute(systemOf(code), {
      delivery: delivery('identity.invitation-mail'),
      invitationId: (event.payload as { invitationId: Id }).invitationId,
      aggregateVersion: event.aggregateVersion,
    });
    expect(sent).toMatchObject({ ok: true, value: { code: 'invitation-mail.sent' } });
    expect(fakes.mails.at(-1)!.text).toContain(`${ACCEPT_PAGES[code]}#`);
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs each decision with the correlation id, never the reason, in both Markets (Sajad 9)', async () => {
    await boot();
    for (const code of TEST_MARKETS) {
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);
      const { sellerId } = await pendingSeller(code);

      expect((await decide(code, sellerId, 'reject')).ok).toBe(true);
      await decisionMailed(code);

      fakes.seedSellerAccess({ ...fakes.sellerAccess.get(sellerId)!, state: 'approved' });
      const suspended = await adminPost(
        code,
        `sellers/${sellerId}/suspend`,
        { reason: REASON },
        root,
      );
      expect(suspended.status).toBe(200);
      await decisionMailed(code);
      expect(
        logLines.find(
          (l) =>
            l.msg === 'identity.admin-suspend-seller' &&
            l.correlationId === suspended.headers['x-correlation-id'],
        ),
      ).toMatchObject({ outcome: 'seller-access.suspended', marketId: code });
    }
    expect(fakes.mails.filter((m) => m.text.includes(REASON))).toHaveLength(4);
    for (const record of [logLines, fakes.audits, fakes.events]) {
      expect(JSON.stringify(record)).not.toContain('licence number');
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('approves, suspends with a reason the owner reads at sign-in, then reinstates', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);
      const { sellerId, cookie } = await pendingSeller(code);
      staffMember(code, sellerId);

      expect(await decide(code, sellerId, 'approve')).toEqual({
        ok: true,
        value: {
          code: 'seller-access.approved',
          sellerId,
          state: 'approved',
          decisionId: expect.any(String) as string,
        },
      });
      expect((await decisionMailed(code)).to).toBe(OWNER_EMAIL);

      const suspended = await adminPost(
        code,
        `sellers/${sellerId}/suspend`,
        { reason: REASON },
        root,
      );
      expect(suspended.status).toBe(200);
      expect(suspended.body).toMatchObject({ code: 'seller-access.suspended', state: 'suspended' });
      expect(JSON.stringify(suspended.body)).not.toContain('licence');
      expect((await decisionMailed(code)).text).toContain(REASON);
      const session = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie });
      expect(session.body).toEqual({ statusCode: 401, code: 'session.invalid' });
      const refused = await sellerPost(code, 'sign-in', { email: OWNER_EMAIL, password: PASSWORD });
      expect(refused.body).toEqual({
        statusCode: 403,
        code: 'seller-access.suspended',
        details: { reason: REASON },
      });
      // Staff get the code only (decision 9; Sajad 4).
      const staff = await sellerPost(code, 'sign-in', { email: STAFF_EMAIL, password: PASSWORD });
      expect(staff.body).toEqual({ statusCode: 403, code: 'seller-access.suspended' });
      // Before the password is right, nothing about the suspension is told (AC 7).
      const wrong = await sellerPost(code, 'sign-in', {
        email: OWNER_EMAIL,
        password: `${PASSWORD}!`,
      });
      expect(wrong.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });

      const reinstated = await adminPost(code, `sellers/${sellerId}/reinstate`, {}, root);
      expect(reinstated.status).toBe(200);
      expect(reinstated.body).toMatchObject({
        code: 'seller-access.reinstated',
        state: 'approved',
      });
      const signedIn = await sellerPost(code, 'sign-in', {
        email: OWNER_EMAIL,
        password: PASSWORD,
      });
      expect(signedIn.status).toBe(200);
    });

    it('rejects with a reason: the owner reads it on the status page', async () => {
      await boot();
      await seeded(code);
      sessionOf(code, rootOf(code), 1);
      const { sellerId } = await pendingSeller(code);

      expect((await decide(code, sellerId, 'reject')).ok).toBe(true);
      expect((await decisionMailed(code)).text).toContain(REASON);
      const signedIn = await sellerPost(code, 'sign-in', {
        email: OWNER_EMAIL,
        password: PASSWORD,
      });
      expect(signedIn.status).toBe(200);
      const status = await http()
        .get('/identity/seller/status')
        .set({ 'x-market-id': code, cookie: cookieOf(signedIn.headers['set-cookie']) });
      expect(status.body).toMatchObject({
        sellerId,
        state: 'rejected',
        reason: REASON,
        // The Market's limit is 3 and no re-application was made yet.
        reapplyLimitReached: false,
      });
    });

    it('refuses what the rules refuse, with the codes of the routes', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);
      const viewer = sessionOf(code, viewerOf(code), 2);
      const { sellerId } = await pendingSeller(code);
      const answer = async (path: string, body: unknown, headers = root) => {
        const response = await adminPost(code, path, body, headers);
        return [response.status, response.body] as const;
      };

      // Approve and reject are `sellers`' routes now (sellers slice 7a-decide): gone from here.
      expect(await answer(`sellers/${sellerId}/approve`, {})).toEqual([
        404,
        expect.objectContaining({ statusCode: 404 }),
      ]);
      expect(await answer(`sellers/${sellerId}/reject`, { reason: REASON })).toEqual([
        404,
        expect.objectContaining({ statusCode: 404 }),
      ]);
      expect(await answer(`sellers/${sellerId}/suspend`, { reason: REASON }, viewer)).toEqual([
        403,
        { statusCode: 403, code: 'access.denied' },
      ]);
      expect(await answer(`sellers/${MISSING}/reinstate`, {})).toEqual([
        404,
        { statusCode: 404, code: 'seller.unknown' },
      ]);
      expect(await answer('sellers/not-an-id/reinstate', {})).toEqual([
        404,
        { statusCode: 404, code: 'seller.unknown' },
      ]);
      // The reason is judged on an approved seller (suspend checks the state first).
      fakes.seedSellerAccess({ ...fakes.sellerAccess.get(sellerId)!, state: 'approved' });
      expect(await answer(`sellers/${sellerId}/suspend`, { reason: '  ' })).toEqual([
        400,
        { statusCode: 400, code: 'seller-access.reason-required' },
      ]);
      expect(await answer(`sellers/${sellerId}/suspend`, { reason: 'a \u202e b' })).toEqual([
        400,
        {
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'reason', code: 'characters' }] },
        },
      ]);
      expect(await answer(`sellers/${sellerId}/reinstate`, {})).toEqual([
        409,
        { statusCode: 409, code: 'seller-access.wrong-state' },
      ]);
      expect(await answer(`sellers/${sellerId}/reinstate`, { extra: true })).toMatchObject([
        400,
        { code: 'validation.failed' },
      ]);
      const withoutCsrf = { ...root, 'x-csrf-token': '' };
      expect(await answer(`sellers/${sellerId}/reinstate`, {}, withoutCsrf)).toEqual([
        403,
        { statusCode: 403, code: 'request.csrf' },
      ]);
      expect(fakes.decisions.size).toBe(0);
    });

    it('answers access.unavailable to a seller invitation when the Market has no accept page', async () => {
      await boot({ withoutAcceptPage: true });
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);

      const response = await adminPost(
        code,
        'seller-invitations',
        { email: INVITEE, displayName: NAME },
        root,
      );

      expect(response.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
      expect(fakes.sellerAccess.size).toBe(0);
    });

    it('creates a seller by invitation; the owner accepts with a password and signs in', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);

      const issued = await adminPost(
        code,
        'seller-invitations',
        { email: INVITEE, displayName: NAME },
        root,
      );
      expect(issued.status).toBe(201);
      expect(issued.body).toEqual({
        code: 'invitation.issued',
        invitationId: expect.any(String) as string,
        sellerId: expect.any(String) as string,
      });
      const { sellerId } = issued.body as { sellerId: string };
      expect(fakes.sellerAccess.get(sellerId)).toMatchObject({ origin: 'invitation' });
      const token = await invitationMailed(code);

      const accepted = await sellerPost(code, 'accept-invitation', { token, password: PASSWORD });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toEqual({ code: 'invitation.accepted' });
      expect(accepted.headers['set-cookie']).toBeUndefined();
      const replayed = await sellerPost(code, 'accept-invitation', { token, password: PASSWORD });
      expect(replayed.body).toEqual({ statusCode: 400, code: 'invitation.rejected' });

      const owner = [...fakes.accounts.values()].find(
        (a) => a.email.normalized === INVITEE.toLowerCase(),
      )!;
      expect(owner).toMatchObject({ population: 'seller', displayName: NAME });
      expect(owner.emailVerifiedAt).not.toBeNull();
      const signedIn = await sellerPost(code, 'sign-in', { email: INVITEE, password: PASSWORD });
      expect(signedIn.status).toBe(200);
      const session = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: cookieOf(signedIn.headers['set-cookie']) });
      expect(session.body).toMatchObject({ sellerId, population: 'seller' });
      const toFull = await adminPost(
        code,
        `sellers/${sellerId}/invitations`,
        { email: 'someone.else@example.com', displayName: NAME },
        root,
      );
      expect(toFull.body).toEqual({ statusCode: 409, code: 'seller.has-members' });
    });

    it('revokes a pending owner invitation: its link stops working; re-sends another', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);
      const issued = await adminPost(
        code,
        'seller-invitations',
        { email: INVITEE, displayName: NAME },
        root,
      );
      const { invitationId } = issued.body as { invitationId: string };
      const token = await invitationMailed(code);

      const resent = await adminPost(code, `seller-invitations/${invitationId}/resend`, {}, root);
      expect(resent.status).toBe(200);
      expect(resent.body).toMatchObject({ invitationId });
      const revoked = await adminPost(code, `seller-invitations/${invitationId}/revoke`, {}, root);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ invitationId });

      const accepted = await sellerPost(code, 'accept-invitation', { token, password: PASSWORD });
      expect(accepted.body).toEqual({ statusCode: 400, code: 'invitation.rejected' });
      const viewer = sessionOf(code, viewerOf(code), 2);
      const denied = await adminPost(
        code,
        'seller-invitations',
        { email: 'other@example.com', displayName: NAME },
        viewer,
      );
      expect(denied.body).toEqual({ statusCode: 403, code: 'access.denied' });
    });

    it('refuses a second invitation to the address, and re-send or revoke once accepted or from another Market', async () => {
      await boot();
      await seeded(code);
      const otherCode = TEST_MARKETS.find((c) => c !== code)!;
      await seeded(otherCode);
      const root = sessionOf(code, rootOf(code), 1);
      const otherRoot = sessionOf(otherCode, rootOf(otherCode), 3);
      const issued = await adminPost(
        code,
        'seller-invitations',
        { email: INVITEE, displayName: NAME },
        root,
      );
      const { invitationId } = issued.body as { invitationId: string };

      const again = await adminPost(
        code,
        'seller-invitations',
        { email: INVITEE.toLowerCase(), displayName: NAME },
        root,
      );
      expect(again.body).toEqual({ statusCode: 409, code: 'invitation.already-pending' });
      expect([...fakes.sellerAccess.values()].filter((a) => a.marketId === code)).toHaveLength(1);
      for (const verb of ['resend', 'revoke']) {
        const foreign = await adminPost(
          otherCode,
          `seller-invitations/${invitationId}/${verb}`,
          {},
          otherRoot,
        );
        expect(foreign.body).toEqual({ statusCode: 404, code: 'invitation.unknown' });
      }

      const token = await invitationMailed(code);
      await sellerPost(code, 'accept-invitation', { token, password: PASSWORD });
      for (const verb of ['resend', 'revoke']) {
        const late = await adminPost(code, `seller-invitations/${invitationId}/${verb}`, {}, root);
        expect(late.body).toEqual({ statusCode: 409, code: 'invitation.rejected' });
      }
    });

    it('answers 429 with Retry-After once the invitation mails of an address are used up (Hassan M1)', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, rootOf(code), 1);
      const limit = app.get(MarketRegistry).get(marketOf(code).marketId).identity.mailThrottles
        .account.limit;
      for (let n = 0; n < limit; n += 1) {
        const issued = await adminPost(
          code,
          'seller-invitations',
          { email: INVITEE, displayName: NAME },
          root,
        );
        expect(issued.status).toBe(201);
        const { invitationId } = issued.body as { invitationId: string };
        await adminPost(code, `seller-invitations/${invitationId}/revoke`, {}, root);
      }

      const refused = await adminPost(
        code,
        'seller-invitations',
        { email: INVITEE, displayName: NAME },
        root,
      );

      expect(refused.status).toBe(429);
      expect(refused.body).toEqual({
        statusCode: 429,
        code: 'request.throttled',
        details: { retryAfterSeconds: expect.any(Number) as number },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    describe('re-apply through the seller-access contract (Sajad 5)', () => {
      async function rejectedSeller() {
        await seeded(code);
        sessionOf(code, rootOf(code), 1);
        const { sellerId } = await pendingSeller(code);
        staffMember(code, sellerId);
        await decide(code, sellerId, 'reject');
        const owner = [...fakes.accounts.values()].find(
          (a) => a.marketId === code && a.email.normalized === OWNER_EMAIL.toLowerCase(),
        )!;
        const actorOf = (accountId: Id<'Account'>) =>
          testCallContext(
            marketOf(code),
            testAuthenticatedActor(marketOf(code), {
              population: 'seller',
              accountId,
              sessionId: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf1f0)}`),
              sellerId: sellerId,
            }),
          );
        return {
          sellerId: sellerId,
          owner: actorOf(owner.id),
          staff: actorOf(staffOf(code)),
        };
      }
      const contract = () =>
        app.get<SellerAccessContract>(SELLER_ACCESS_CONTRACT, { strict: false });

      it('fails closed when the Market configures no limit', async () => {
        await boot({ withoutReapplyLimit: true });
        const { sellerId, owner } = await rejectedSeller();

        await expect(contract().reapplySellerAccess(owner, sellerId)).resolves.toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
      });

      it("lets the owner apply again up to the Market's limit of 3; staff cannot", async () => {
        await boot();
        const { sellerId, owner, staff } = await rejectedSeller();

        await expect(contract().reapplySellerAccess(staff, sellerId)).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        for (const reapplyCount of [1, 2, 3]) {
          await expect(contract().reapplySellerAccess(owner, sellerId)).resolves.toEqual({
            ok: true,
            value: { code: 'seller-access.reapplied', sellerId, state: 'pending', reapplyCount },
          });
          expect((await decide(code, sellerId, 'reject')).ok).toBe(true);
        }
        await expect(contract().reapplySellerAccess(owner, sellerId)).resolves.toEqual({
          ok: false,
          error: { code: 'seller-access.reapply-limit' },
        });
      });
    });
  });
});
