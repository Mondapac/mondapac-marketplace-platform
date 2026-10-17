import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin team list over HTTP (identity design 5.3 `identity.admin-account.view`, 8.6 rows 2
// and 6; slice 8c): `GET /identity/admin/team` with the real guards, controller, gate and use
// case, identity's database ports as in-memory fakes and a fixed clock. Admin sessions are
// seeded into the fake store, as in the 8a-2/8b routes' spec.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const TOKEN_HASH = new Uint8Array(32).fill(9);

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
const SUPPORT = accountId(4);
const CUSTOMER = accountId(5);
const INVITATION = id<'Invitation'>('01990000-0000-7000-8000-00000009f401');

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('admin team list over HTTP (integration, slice 8c)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'list-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: population === 'customer' ? null : `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(n, idOf, 'admin');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, ROOT2, 'platform-administrator');
    admin(3, VIEWER, 'viewer');
    admin(4, SUPPORT, 'operations-support');
    account(5, CUSTOMER, 'customer');
    fakes.invitations.set(INVITATION, {
      id: INVITATION,
      marketId,
      kind: 'admin',
      email: { typed: 'Invitee@Example.com', normalized: 'invitee@example.com' },
      displayName: null,
      roleId: roleOf(code, 'viewer'),
      sellerId: null,
      invitedByAccountId: ROOT,
      tokenHash: TOKEN_HASH,
      expiresAt: START.add({ hours: 1 }),
      state: 'pending',
      decidedAt: null,
      acceptedAccountId: null,
      createdAt: START,
      version: 2,
    });
  }

  /** A session of `account` and `population`, stored as a sign-in would; answers its cookie. */
  function cookieOf(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'customer' = 'admin',
  ): string {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return `__Host-session-${population}-${code}=${issued.token}`;
  }

  /** An admin session's cookie and CSRF token, for a command after the list. */
  function sessionHeaders(code: string, account: Id<'Account'>, n: number) {
    const cookie = cookieOf(code, account, n);
    const token = cookie.slice(cookie.indexOf('=') + 1);
    return { cookie, 'x-csrf-token': csrfTokenFor(token) };
  }

  const team = (code: string, cookie: string | null, query = '') => {
    const call = http()
      .get(`/identity/admin/team${query}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return cookie === null ? call : call.set('cookie', cookie);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route, its query and both row shapes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, { get?: { parameters?: { name: string; in: string }[] } }>;
      components: { schemas: Record<string, unknown> };
    };

    const operation = document.paths['/identity/admin/team']?.get;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'limit', in: 'query' }),
        expect.objectContaining({ name: 'after', in: 'query' }),
      ]),
    );
    for (const schema of [
      'AdminTeamPageView',
      'AdminTeamAccountRowView',
      'AdminTeamInvitationRowView',
      'AdminTeamActionHint',
    ]) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists admins with roles, open invitations and hints; logs no address or name', async () => {
      await boot();
      await seeded(code);

      const listed = await team(code, cookieOf(code, ROOT, 1));

      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      const body = listed.body as { items: Record<string, unknown>[]; next: string | null };
      expect(body.next).toBeNull();
      expect(body.items.map((row) => row.accountId ?? row.invitationId)).toEqual([
        ROOT,
        ROOT2,
        VIEWER,
        SUPPORT,
        INVITATION,
      ]);
      expect(body.items[1]).toEqual({
        type: 'account',
        accountId: ROOT2,
        email: 'Person2@Example.com',
        displayName: 'Person 2',
        status: 'active',
        self: false,
        role: {
          roleId: roleOf(code, 'platform-administrator'),
          kind: 'system',
          seedCode: 'platform-administrator',
          name: null,
        },
        actions: {
          changeRole: { allowed: true, code: null },
          disable: { allowed: true, code: null },
          enable: { allowed: false, code: 'account.already-active' },
          resetSecondFactor: { allowed: false, code: 'second-factor.none' },
        },
      });
      expect(body.items[4]).toEqual({
        type: 'invitation',
        invitationId: INVITATION,
        email: 'Invitee@Example.com',
        role: { roleId: roleOf(code, 'viewer'), kind: 'default', seedCode: 'viewer', name: null },
        invitedByAccountId: ROOT,
        status: 'pending',
        createdAt: START.toString(),
        expiresAt: START.add({ hours: 1 }).toString(),
        actions: {
          resend: { allowed: true, code: null },
          revoke: { allowed: true, code: null },
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/token|hash|secret|credential/i);
      expect(logLines.find((l) => l.msg === 'identity.admin-list-team')).toMatchObject({
        outcome: 'ok',
        marketId: code,
        correlationId: listed.headers['x-correlation-id'] as string,
      });
      expect(logLines.find((l) => l.msg === 'identity.list-admin-team')).toMatchObject({
        outcome: 'admin-team.listed',
        rows: 5,
        correlationId: listed.headers['x-correlation-id'] as string,
      });
      const logged = JSON.stringify(logLines).toLowerCase();
      for (const personal of ['person1@', 'person2@', 'invitee@', 'person 2']) {
        expect(logged).not.toContain(personal);
      }
    });

    it('gives a view-only admin every action as access.denied', async () => {
      await boot();
      await seeded(code);

      const listed = await team(code, cookieOf(code, VIEWER, 3));

      expect(listed.status).toBe(200);
      const items = (listed.body as { items: { actions: Record<string, unknown> }[] }).items;
      for (const row of items) {
        for (const hint of Object.values(row.actions)) {
          expect(hint).toEqual({ allowed: false, code: 'access.denied' });
        }
      }
    });

    it('refuses an admin without identity.admin-account.view (access.denied)', async () => {
      await boot();
      await seeded(code);

      const refused = await team(code, cookieOf(code, SUPPORT, 4));

      expect([refused.status, refused.body]).toEqual([
        403,
        { statusCode: 403, code: 'access.denied' },
      ]);
      expect(logLines.find((l) => l.msg === 'identity.admin-list-team')).toMatchObject({
        outcome: 'access.denied',
      });
    });

    it('refuses no session and a customer session (populations)', async () => {
      await boot();
      await seeded(code);

      const none = await team(code, null);
      expect(none.status).toBe(401);
      const customer = await team(code, cookieOf(code, CUSTOMER, 5, 'customer'));
      expect(customer.status).toBe(401);
      // An admin cookie carrying a customer's session is refused too.
      const forged = cookieOf(code, CUSTOMER, 6, 'customer').replace(
        `session-customer-${code}`,
        `session-admin-${code}`,
      );
      expect((await team(code, forged)).status).toBe(401);
    });

    it('takes a default page of 50 without limit, and accepts limit=100', async () => {
      await boot();
      await seeded(code);
      const cookie = cookieOf(code, ROOT, 1);

      const defaulted = await team(code, cookie);
      expect(defaulted.status).toBe(200);
      expect((defaulted.body as { items: unknown[]; next: unknown }).items).toHaveLength(5);
      // 51 admins in all: the default page holds 50 and answers a next.
      for (let n = 10; n < 56; n += 1) {
        fakes.seedAccount({ ...fakes.accounts.get(VIEWER)!, id: accountId(n) });
      }
      const full = await team(code, cookie);
      expect((full.body as { items: unknown[] }).items).toHaveLength(50);
      expect((full.body as { next: string | null }).next).not.toBeNull();
      const largest = await team(code, cookie, '?limit=100');
      expect(largest.status).toBe(200);
      expect((largest.body as { items: unknown[]; next: unknown }).items).toHaveLength(51);
      expect((largest.body as { next: unknown }).next).toBeNull();
    });

    it('lists an expired invitation as expired, with resend and revoke hints the commands keep', async () => {
      await boot();
      await seeded(code);
      // Its mail expired an hour ago; it is still within the admin invitation lifetime.
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      const root = sessionHeaders(code, ROOT, 7);

      const listed = await team(code, root.cookie);
      const row = (listed.body as { items: Record<string, unknown>[] }).items.find(
        (r) => r.invitationId === INVITATION,
      );
      expect(row).toMatchObject({
        status: 'expired',
        actions: {
          resend: { allowed: true, code: null },
          revoke: { allowed: true, code: null },
        },
      });

      const post = (path: string) =>
        http()
          .post(`/identity/admin/invitations/${INVITATION}/${path}`)
          .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...root })
          .send({});
      const resent = await post('resend');
      expect([resent.status, resent.body]).toEqual([
        200,
        { code: 'invitation.reissued', invitationId: INVITATION },
      ]);
      const revoked = await post('revoke');
      expect([revoked.status, revoked.body]).toEqual([
        200,
        { code: 'invitation.revoked', invitationId: INVITATION },
      ]);
    });

    it('pages with after and limit, and validates the query', async () => {
      await boot();
      await seeded(code);
      const cookie = cookieOf(code, ROOT, 1);

      const first = await team(code, cookie, '?limit=2');
      expect(first.status).toBe(200);
      const firstBody = first.body as { items: { accountId?: string }[]; next: string };
      expect(firstBody.items.map((row) => row.accountId)).toEqual([ROOT, ROOT2]);
      expect(firstBody.next).toBe(ROOT2);
      const second = await team(code, cookie, `?limit=2&after=${firstBody.next}`);
      expect(
        (second.body as { items: { accountId?: string }[] }).items.map((r) => r.accountId),
      ).toEqual([VIEWER, SUPPORT]);

      for (const [query, path] of [
        ['?limit=0', 'limit'],
        ['?limit=101', 'limit'],
        ['?limit=abc', 'limit'],
        ['?limit=1&limit=2', 'limit'],
        ['?after=nope', 'after'],
        ['?page=2', 'page'],
        [`?after=${ROOT}&after=${ROOT2}`, 'after'],
        ['?after=', 'after'],
      ] as const) {
        const refused = await team(code, cookie, query);
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [expect.objectContaining({ path })] },
        });
      }
    });
  });
});
