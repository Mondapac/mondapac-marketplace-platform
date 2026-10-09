import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  LINK_TARGETS,
  type LinkTargets,
} from '../src/modules/identity/application/ports/link-secrets';
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
const ACCEPT_PAGE = 'https://seller.example.test/accept-invitation';

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const ROOT = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa001)}`);
const VIEWER = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa002)}`);
const MISSING = '01990000-0000-7000-8000-00000000ffff';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let deliveries = 0;

/** The real link targets, with the seller accept page the Market configuration lacks today. */
function withSellerAcceptPage(markets: MarketRegistry): LinkTargets {
  const base = new MarketConfigIdentityPolicy(markets);
  return {
    target: (market: MarketContext, population, page) =>
      population === 'seller' && page === 'accept-invitation'
        ? ACCEPT_PAGE
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

  async function boot(options: { readonly acceptPage?: boolean } = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        options.acceptPage === true
          ? fakes
              .override(builder)
              .overrideProvider(LINK_TARGETS)
              .useFactory({ factory: withSellerAcceptPage, inject: [MarketRegistry] })
          : fakes.override(builder),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const systemOf = (code: string) => testCallContext(marketOf(code), 'system', 'admin-sell-0001');
  const delivery = (subscriber: string) => ({
    eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
    subscriber,
    attempt: 1,
  });
  const roleOf = (seedCode: string) =>
    [...fakes.roles.values()].find((r) => r.scope === 'platform' && r.seedCode === seedCode)!.id;

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
      [1, ROOT, 'platform-administrator'],
      [2, VIEWER, 'viewer'],
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
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId,
        roleId: roleOf(seedCode),
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
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
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
    const [seller] = [...fakes.sellerAccess.values()];
    // ZZ approves on sign-up; both Markets start these tests from "waiting for approval".
    fakes.seedSellerAccess({ ...seller!, state: 'pending' });
    return { sellerId: seller!.sellerId, cookie: cookieOf(confirmed.headers['set-cookie']) };
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
    expect(fakes.mails.at(-1)!.text).toContain(`${ACCEPT_PAGE}#`);
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs each decision with the correlation id, never the reason', async () => {
    await boot();
    await seeded('AU');
    const root = sessionOf('AU', ROOT, 1);
    const { sellerId } = await pendingSeller('AU');

    const rejected = await adminPost('AU', `sellers/${sellerId}/reject`, { reason: REASON }, root);

    expect(rejected.status).toBe(200);
    expect(logLines.find((l) => l.msg === 'identity.admin-reject-seller')).toMatchObject({
      outcome: 'seller-access.rejected',
      marketId: 'AU',
      correlationId: rejected.headers['x-correlation-id'] as string,
    });
    expect(JSON.stringify(logLines)).not.toContain('licence number');
    expect(JSON.stringify(fakes.audits)).not.toContain('licence number');
    expect(JSON.stringify(fakes.events)).not.toContain('licence number');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('approves, suspends with a reason the owner reads at sign-in, then reinstates', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const { sellerId, cookie } = await pendingSeller(code);

      const approved = await adminPost(code, `sellers/${sellerId}/approve`, {}, root);
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual({
        code: 'seller-access.approved',
        sellerId,
        state: 'approved',
        decisionId: expect.any(String) as string,
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
      const root = sessionOf(code, ROOT, 1);
      const { sellerId } = await pendingSeller(code);

      const rejected = await adminPost(
        code,
        `sellers/${sellerId}/reject`,
        { reason: REASON },
        root,
      );
      expect(rejected.status).toBe(200);
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
        reapplyLimitReached: false,
      });
    });

    it('refuses what the rules refuse, with the codes of the routes', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const viewer = sessionOf(code, VIEWER, 2);
      const { sellerId } = await pendingSeller(code);
      const answer = async (path: string, body: unknown, headers = root) => {
        const response = await adminPost(code, path, body, headers);
        return [response.status, response.body] as const;
      };

      expect(await answer(`sellers/${sellerId}/approve`, {}, viewer)).toEqual([
        403,
        { statusCode: 403, code: 'access.denied' },
      ]);
      expect(await answer(`sellers/${MISSING}/approve`, {})).toEqual([
        404,
        { statusCode: 404, code: 'seller.unknown' },
      ]);
      expect(await answer('sellers/not-an-id/approve', {})).toEqual([
        404,
        { statusCode: 404, code: 'seller.unknown' },
      ]);
      expect(await answer(`sellers/${sellerId}/reject`, { reason: '  ' })).toEqual([
        400,
        { statusCode: 400, code: 'seller-access.reason-required' },
      ]);
      expect(await answer(`sellers/${sellerId}/reject`, { reason: 'a ‮ b' })).toEqual([
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
      expect(await answer(`sellers/${sellerId}/approve`, { extra: true })).toMatchObject([
        400,
        { code: 'validation.failed' },
      ]);
      const withoutCsrf = { ...root, 'x-csrf-token': '' };
      expect(await answer(`sellers/${sellerId}/approve`, {}, withoutCsrf)).toEqual([
        403,
        { statusCode: 403, code: 'request.csrf' },
      ]);
      expect(fakes.decisions.size).toBe(0);
    });

    it('answers access.unavailable to a seller invitation while the Market has no accept page', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

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
      await boot({ acceptPage: true });
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

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
      await boot({ acceptPage: true });
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
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
      const viewer = sessionOf(code, VIEWER, 2);
      const denied = await adminPost(
        code,
        'seller-invitations',
        { email: 'other@example.com', displayName: NAME },
        viewer,
      );
      expect(denied.body).toEqual({ statusCode: 403, code: 'access.denied' });
    });
  });
});
