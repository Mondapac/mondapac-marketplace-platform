import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { AcceptAdminInvitation } from '../src/modules/identity/application/use-cases/accept-admin-invitation.use-case';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from '../src/modules/identity/application/use-cases/send-invitation-mail.use-case';
import { StartAdminInvitationAcceptance } from '../src/modules/identity/application/use-cases/start-admin-invitation-acceptance.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { openSession } from '../src/modules/identity/domain/session';
import { TOTP } from '../src/modules/identity/domain/totp';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from '../src/modules/identity/application/ports/identity-market-policy';
import { MarketConfigIdentityPolicy } from '../src/modules/identity/infrastructure/market-config-identity-policy';
import { CLOCK } from '../src/platform/clock/clock.module';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin team routes over HTTP (identity design 3.1, 3.4, 3.6, 5.3 to 5.5; slices 8a-2 and
// 8b): the real guards, controller and use cases, with identity's database ports and the mail
// transport as in-memory fakes and a fixed clock. Admin sessions are seeded into the fake store
// (slice 7b's tests cover how one opens); the invitee's acceptance runs through the use cases.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };
const INVITEE = 'New.Admin@Example.com';
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const ROOT2 = accountId(2);
const VIEWER = accountId(3);
const CUSTOMER = accountId(4);
const MISSING = '01990000-0000-7000-8000-00000000ffff';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;
let deliveries = 0;

describe('admin team routes over HTTP (integration, slices 8a-2 and 8b)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot(options: { readonly withoutInvitationLifetime?: boolean } = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) => {
        const built = fakes.override(builder).overrideProvider(CLOCK).useValue(clock);
        return options.withoutInvitationLifetime === true
          ? built
              .overrideProvider(IDENTITY_MARKET_POLICY)
              .useFactory({ factory: withoutInvitationLifetime, inject: [MarketRegistry] })
          : built;
      },
    }));
  }

  /** The real policy of a Market that configures no admin invitation lifetime. */
  function withoutInvitationLifetime(markets: MarketRegistry): IdentityMarketPolicy {
    const base = new MarketConfigIdentityPolicy(markets);
    return Object.assign(Object.create(base) as IdentityMarketPolicy, {
      invitationLifetimeMinutes: () => null,
    });
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const systemOf = (code: string) => testCallContext(marketOf(code), 'system', 'admin-team-0001');
  const anonymousOf = (code: string) =>
    testCallContext(marketOf(code), 'anonymous', 'admin-team-0002');
  const delivery = (subscriber: string) => ({
    eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
    subscriber,
    attempt: 1,
  });
  const roleOf = (seedCode: string) =>
    [...fakes.roles.values()].find((r) => r.scope === 'platform' && r.seedCode === seedCode)!.id;
  const roleIdOf = (account: Id<'Account'>) =>
    [...fakes.assignments.values()].find((a) => a.accountId === account)?.roleId;

  /** Seeds the roles (through the job's use case) and the accounts of the Market. */
  async function seeded(code: string) {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
        displayName: population === 'customer' ? null : `Account ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(n, idOf, 'admin');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, ROOT2, 'platform-administrator');
    admin(3, VIEWER, 'viewer');
    account(4, CUSTOMER, 'customer');
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
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const post = (code: string, path: string, body: unknown, headers: Record<string, string>) =>
    http()
      .post(`/identity/admin/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);

  /** Runs the invitation mail of the last issued invitation; answers the token it carried. */
  async function mailed(code: string): Promise<string> {
    const event = fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1').at(-1)!;
    const sent = await app.get(SendInvitationMail).execute(systemOf(code), {
      delivery: delivery('identity.invitation-mail'),
      invitationId: (event.payload as { invitationId: Id }).invitationId,
      aggregateVersion: event.aggregateVersion,
    });
    expect(sent).toMatchObject({ ok: true, value: { code: 'invitation-mail.sent' } });
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  /** The invitee's acceptance through the use cases. */
  async function accept(code: string, token: string) {
    const ready = await app
      .get(StartAdminInvitationAcceptance)
      .execute(anonymousOf(code), { token, client: CLIENT });
    if (!ready.ok) return ready;
    const secret = ready.value.secret;
    return app.get(AcceptAdminInvitation).execute(anonymousOf(code), {
      token,
      displayName: 'Invited Admin',
      password: PASSWORD,
      secret,
      tag: ready.value.tag,
      expiresAt: ready.value.expiresAt.toString(),
      code: hotp(
        decodeBase32Secret(secret)!,
        Math.floor(clock.now().epochMilliseconds / 1000 / TOTP.periodSeconds),
      ),
      client: CLIENT,
    });
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('logs each outcome with the correlation id, never the invitee address', async () => {
    await boot();
    await seeded('AU');
    const root = sessionOf('AU', ROOT, 1);

    const issued = await post(
      'AU',
      'invitations',
      { email: INVITEE, roleId: roleOf('viewer') },
      root,
    );

    expect(issued.status).toBe(201);
    expect(logLines.find((l) => l.msg === 'identity.admin-invite')).toMatchObject({
      outcome: 'invitation.issued',
      marketId: 'AU',
      correlationId: issued.headers['x-correlation-id'] as string,
    });
    expect(JSON.stringify(logLines).toLowerCase()).not.toContain(INVITEE.toLowerCase());
    expect(JSON.stringify(fakes.audits).toLowerCase()).not.toContain(INVITEE.toLowerCase());
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('invites an admin with a role; the acceptance gives that role, assigned by the inviter', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const issued = await post(
        code,
        'invitations',
        { email: INVITEE, roleId: roleOf('viewer') },
        root,
      );
      expect(issued.status).toBe(201);
      expect(issued.body).toEqual({
        code: 'invitation.issued',
        invitationId: expect.any(String) as string,
      });
      const token = await mailed(code);

      await expect(accept(code, token)).resolves.toMatchObject({ ok: true });
      const invitee = [...fakes.accounts.values()].find(
        (a) => a.email.normalized === INVITEE.toLowerCase(),
      )!;
      expect(invitee.population).toBe('admin');
      expect([...fakes.assignments.values()].find((a) => a.accountId === invitee.id)).toMatchObject(
        { roleId: roleOf('viewer'), assignedByAccountId: ROOT },
      );
      expect(fakes.audits.filter((a) => a.action === 'identity.invitation.issued')).toEqual([
        expect.objectContaining({ actor: 'authenticated', marketId: code }),
      ]);
    });

    it('refuses the acceptance once the inviter is disabled (Hassan 14.2)', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const root2 = sessionOf(code, ROOT2, 2);

      await post(code, 'invitations', { email: INVITEE, roleId: roleOf('viewer') }, root2);
      const token = await mailed(code);
      const disabled = await post(code, `accounts/${ROOT2}/disable`, {}, root);
      expect(disabled.status).toBe(200);

      await expect(accept(code, token)).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect([...fakes.accounts.values()].filter((a) => a.population === 'admin')).toHaveLength(3);
    });

    it("changes an admin's role, and refuses one's own", async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const changed = await post(
        code,
        `accounts/${VIEWER}/role`,
        { roleId: roleOf('operations-support') },
        root,
      );
      expect(changed.status).toBe(200);
      expect(changed.body).toEqual({
        code: 'role.assigned',
        accountId: VIEWER,
        roleId: roleOf('operations-support'),
      });
      expect(roleIdOf(VIEWER)).toBe(roleOf('operations-support'));

      const self = await post(code, `accounts/${ROOT}/role`, { roleId: roleOf('viewer') }, root);
      expect(self.status).toBe(403);
      expect(self.body).toEqual({ statusCode: 403, code: 'member.self' });
      const malformed = await post(code, `accounts/${VIEWER}/role`, { roleId: 'x' }, root);
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ code: 'validation.failed' });
    });

    it('disables an admin: its session stops working at once; enables it again', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const viewer = sessionOf(code, VIEWER, 3);
      const before = await http()
        .get('/identity/admin/session')
        .set({ 'x-market-id': code, cookie: viewer.cookie });
      expect(before.status).toBe(200);

      const disabled = await post(code, `accounts/${VIEWER}/disable`, {}, root);
      expect(disabled.status).toBe(200);
      expect(disabled.body).toEqual({ code: 'account.disabled', accountId: VIEWER });
      const after = await http()
        .get('/identity/admin/session')
        .set({ 'x-market-id': code, cookie: viewer.cookie });
      expect(after.status).toBe(401);

      const again = await post(code, `accounts/${VIEWER}/disable`, {}, root);
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ statusCode: 409, code: 'account.already-disabled' });
      const enabled = await post(code, `accounts/${VIEWER}/enable`, {}, root);
      expect(enabled.status).toBe(200);
      expect(enabled.body).toEqual({ code: 'account.enabled', accountId: VIEWER });
    });

    it('disables a customer, and answers 404 for an admin id on the customer route', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const disabled = await post(code, `customers/${CUSTOMER}/disable`, {}, root);
      expect(disabled.status).toBe(200);
      expect(fakes.accounts.get(CUSTOMER)!.status).toBe('disabled');
      const wrongKind = await post(code, `customers/${VIEWER}/disable`, {}, root);
      expect(wrongKind.status).toBe(404);
      expect(wrongKind.body).toEqual({ statusCode: 404, code: 'account.unknown' });
    });

    it("resets another admin's second factor; 409 when it has none", async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      fakes.factors.set(VIEWER, {
        id: id<'SecondFactor'>('01990000-0000-7000-8000-00000000f301'),
        marketId: code as AccountState['marketId'],
        accountId: VIEWER,
        state: 'pending',
        secretCiphertext: 'sealed',
        pendingSecretCiphertext: null,
        lastAcceptedStep: null,
        activatedAt: null,
        lockedAt: null,
        createdAt: START,
        recoveryCodes: [],
        version: 1,
      });

      const reset = await post(code, `accounts/${VIEWER}/second-factor/reset`, {}, root);
      expect(reset.status).toBe(200);
      expect(reset.body).toEqual({ code: 'second-factor.reset', accountId: VIEWER });
      expect(fakes.factors.has(VIEWER)).toBe(false);
      const none = await post(code, `accounts/${VIEWER}/second-factor/reset`, {}, root);
      expect(none.status).toBe(409);
      expect(none.body).toEqual({ statusCode: 409, code: 'second-factor.none' });
    });

    it('resends and revokes an invitation; a malformed or missing id is the same 404', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const issued = await post(
        code,
        'invitations',
        { email: INVITEE, roleId: roleOf('viewer') },
        root,
      );
      const invitationId = (issued.body as { invitationId: string }).invitationId;

      const resent = await post(code, `invitations/${invitationId}/resend`, {}, root);
      expect(resent.status).toBe(200);
      expect(resent.body).toEqual({ code: 'invitation.reissued', invitationId });
      const revoked = await post(code, `invitations/${invitationId}/revoke`, {}, root);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ code: 'invitation.revoked', invitationId });

      const missing = await post(code, `invitations/${MISSING}/revoke`, {}, root);
      const malformed = await post(code, 'invitations/not-an-id/revoke', {}, root);
      for (const answer of [missing, malformed]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ statusCode: 404, code: 'invitation.unknown' });
      }
      const account = await post(code, `accounts/${MISSING}/disable`, {}, root);
      expect(account.body).toEqual({ statusCode: 404, code: 'account.unknown' });
    });

    it('refuses without the CSRF token, without a session, and without the permission', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const viewer = sessionOf(code, VIEWER, 3);

      const noCsrf = await post(code, `accounts/${VIEWER}/disable`, {}, { cookie: root.cookie });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const anonymous = await post(code, `accounts/${VIEWER}/disable`, {}, {});
      expect(anonymous.status).toBe(401);
      const denied = await post(code, `accounts/${ROOT2}/disable`, {}, viewer);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ statusCode: 403, code: 'access.denied' });
      const extra = await post(code, `accounts/${VIEWER}/disable`, { reason: 'x' }, root);
      expect(extra.status).toBe(400);
      expect(fakes.accounts.get(VIEWER)!.status).toBe('active');
      expect(fakes.accounts.get(ROOT2)!.status).toBe('active');
    });

    /** Each route with a body and a path its refusals are checked on (Sajad 2). */
    const ROUTES: readonly [string, () => string, () => object][] = [
      ['assign role', () => `accounts/${VIEWER}/role`, () => ({ roleId: roleOf('viewer') })],
      ['invite', () => 'invitations', () => ({ email: INVITEE, roleId: roleOf('viewer') })],
      ['resend', () => `invitations/${MISSING}/resend`, () => ({})],
      ['revoke', () => `invitations/${MISSING}/revoke`, () => ({})],
      ['disable admin', () => `accounts/${ROOT2}/disable`, () => ({})],
      ['enable admin', () => `accounts/${ROOT2}/enable`, () => ({})],
      ['disable customer', () => `customers/${CUSTOMER}/disable`, () => ({})],
      ['enable customer', () => `customers/${CUSTOMER}/enable`, () => ({})],
      ['reset factor', () => `accounts/${ROOT2}/second-factor/reset`, () => ({})],
    ];

    it.each(ROUTES)(
      '%s: 403 request.csrf without the token, 401 without a session, 403 without the permission',
      async (_, path, body) => {
        await boot();
        await seeded(code);
        const root = sessionOf(code, ROOT, 1);
        // VIEWER holds only view keys: none of these routes' permissions.
        const viewer = sessionOf(code, VIEWER, 3);

        const noCsrf = await post(code, path(), body(), { cookie: root.cookie });
        expect([noCsrf.status, noCsrf.body]).toEqual([
          403,
          { statusCode: 403, code: 'request.csrf' },
        ]);
        const anonymous = await post(code, path(), body(), {});
        expect(anonymous.status).toBe(401);
        const denied = await post(code, path(), body(), viewer);
        expect([denied.status, denied.body]).toEqual([
          403,
          { statusCode: 403, code: 'access.denied' },
        ]);
        expect(fakes.events).toEqual([]);
        expect(fakes.audits.filter((a) => a.actor === 'authenticated')).toEqual([]);
      },
    );

    it('enables a customer over HTTP; enabling an active one is 409', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const active = await post(code, `customers/${CUSTOMER}/enable`, {}, root);
      expect([active.status, active.body]).toEqual([
        409,
        { statusCode: 409, code: 'account.already-active' },
      ]);
      await post(code, `customers/${CUSTOMER}/disable`, {}, root);
      const enabled = await post(code, `customers/${CUSTOMER}/enable`, {}, root);
      expect([enabled.status, enabled.body]).toEqual([
        200,
        { code: 'account.enabled', accountId: CUSTOMER },
      ]);
      expect(fakes.accounts.get(CUSTOMER)!.status).toBe('active');
    });

    it('answers role.unchanged 200 and the 404 and 409 refusals over HTTP', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const unchanged = await post(
        code,
        `accounts/${VIEWER}/role`,
        { roleId: roleOf('viewer') },
        root,
      );
      expect([unchanged.status, unchanged.body]).toEqual([
        200,
        { code: 'role.unchanged', accountId: VIEWER, roleId: roleOf('viewer') },
      ]);
      const unknownRole = await post(code, `accounts/${VIEWER}/role`, { roleId: MISSING }, root);
      expect([unknownRole.status, unknownRole.body]).toEqual([
        404,
        { statusCode: 404, code: 'role.unknown' },
      ]);
      const exists = await post(
        code,
        'invitations',
        { email: 'A3@example.com', roleId: roleOf('viewer') },
        root,
      );
      expect([exists.status, exists.body]).toEqual([
        409,
        { statusCode: 409, code: 'account.exists' },
      ]);
      await post(code, 'invitations', { email: INVITEE, roleId: roleOf('viewer') }, root);
      const pending = await post(
        code,
        'invitations',
        { email: INVITEE, roleId: roleOf('viewer') },
        root,
      );
      expect([pending.status, pending.body]).toEqual([
        409,
        { statusCode: 409, code: 'invitation.already-pending' },
      ]);
      const revoked = [...fakes.invitations.values()].at(-1)!.id;
      await post(code, `invitations/${revoked}/revoke`, {}, root);
      const decided = await post(code, `invitations/${revoked}/revoke`, {}, root);
      expect([decided.status, decided.body]).toEqual([
        409,
        { statusCode: 409, code: 'invitation.rejected' },
      ]);
    });

    it('refuses a malformed invite body with 400 and the field, never echoing the address', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const badEmail = await post(
        code,
        'invitations',
        { email: 'not-an-address', roleId: roleOf('viewer') },
        root,
      );
      expect([badEmail.status, badEmail.body]).toEqual([
        400,
        {
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'email', code: 'format' }] },
        },
      ]);
      const badRole = await post(code, 'invitations', { email: INVITEE, roleId: 'x' }, root);
      expect([badRole.status, badRole.body]).toEqual([
        400,
        {
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'roleId', code: 'format' }] },
        },
      ]);
      expect(JSON.stringify([badEmail.body, badRole.body])).not.toContain('not-an-address');
      expect(fakes.invitations.size).toBe(0);
    });

    it('answers 503 access.unavailable to invite in a Market without an admin invitation lifetime', async () => {
      await boot({ withoutInvitationLifetime: true });
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const answer = await post(
        code,
        'invitations',
        { email: INVITEE, roleId: roleOf('viewer') },
        root,
      );
      expect([answer.status, answer.body]).toEqual([
        503,
        { statusCode: 503, code: 'access.unavailable' },
      ]);
      expect(fakes.invitations.size).toBe(0);
    });

    it("refuses the acceptance when the inviter is demoted, or the role became a seller's (14.2, I-6)", async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const root2 = sessionOf(code, ROOT2, 2);

      await post(code, 'invitations', { email: INVITEE, roleId: roleOf('viewer') }, root2);
      const demotedToken = await mailed(code);
      await post(code, `accounts/${ROOT2}/role`, { roleId: roleOf('viewer') }, root);
      await expect(accept(code, demotedToken)).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });

      await post(
        code,
        'invitations',
        { email: 'other@example.com', roleId: roleOf('viewer') },
        root,
      );
      const sellerToken = await mailed(code);
      const invitation = [...fakes.invitations.values()].find(
        (i) => i.state === 'pending' && i.invitedByAccountId === ROOT,
      )!;
      const sellerRole = [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'store-manager',
      )!;
      fakes.invitations.set(invitation.id, { ...invitation, roleId: sellerRole.id });
      await expect(accept(code, sellerToken)).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect([...fakes.accounts.values()].filter((a) => a.population === 'admin')).toHaveLength(3);
    });

    it('records the acceptance with an inviter as granted by it, never as founding', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      await post(code, 'invitations', { email: INVITEE, roleId: roleOf('viewer') }, root);
      const token = await mailed(code);
      await expect(accept(code, token)).resolves.toMatchObject({ ok: true });

      expect(fakes.audits.find((a) => a.action === 'identity.account-role.assigned')).toMatchObject(
        {
          actor: 'anonymous',
          after: expect.objectContaining({
            founding: false,
            roleId: roleOf('viewer'),
            scope: 'platform',
          }) as object,
        },
      );
    });

    it('answers 404 for an account, a role or an invitation of the other Market (Hassan L2)', async () => {
      await boot();
      await seeded(code);
      const other = code === 'AU' ? 'ZZ' : 'AU';
      await app.get(SeedRoles).execute(systemOf(other), {});
      const root = sessionOf(code, ROOT, 1);
      const elsewhere = accountId(50);
      fakes.seedAccount({
        ...fakes.accounts.get(VIEWER)!,
        id: elsewhere,
        marketId: other as AccountState['marketId'],
        email: { typed: 'elsewhere@example.com', normalized: 'elsewhere@example.com' },
      });
      const otherRole = [...fakes.roles.values()].find(
        (r) =>
          r.marketId === other && r.scope === 'platform' && r.seedCode === 'operations-support',
      )!.id;
      const otherInvitation = id<'Invitation'>('01990000-0000-7000-8000-00000000f4ee');
      fakes.invitations.set(otherInvitation, {
        id: otherInvitation,
        marketId: other as AccountState['marketId'],
        kind: 'admin',
        email: { typed: 'x@example.com', normalized: 'x@example.com' },
        displayName: null,
        roleId: otherRole,
        sellerId: null,
        invitedByAccountId: ROOT,
        tokenHash: null,
        expiresAt: null,
        state: 'pending',
        decidedAt: null,
        acceptedAccountId: null,
        createdAt: START,
        version: 1,
      });

      const account = await post(code, `accounts/${elsewhere}/disable`, {}, root);
      expect([account.status, account.body]).toEqual([
        404,
        { statusCode: 404, code: 'account.unknown' },
      ]);
      const role = await post(code, `accounts/${VIEWER}/role`, { roleId: otherRole }, root);
      expect([role.status, role.body]).toEqual([404, { statusCode: 404, code: 'role.unknown' }]);
      const invitation = await post(code, `invitations/${otherInvitation}/revoke`, {}, root);
      expect([invitation.status, invitation.body]).toEqual([
        404,
        { statusCode: 404, code: 'invitation.unknown' },
      ]);
      expect(fakes.accounts.get(elsewhere)!.status).toBe('active');
      expect(fakes.invitations.get(otherInvitation)!.state).toBe('pending');
    });
  });
});
