import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from '../src/modules/identity/application/use-cases/send-invitation-mail.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller team over HTTP (identity design 3.4, 5.3 to 5.5, 8.6; `ux.md` B1, A9; slice 11):
// the real guards, controllers, gate and use cases, identity's database ports and the mail
// transport as in-memory fakes, and a fixed clock. Sessions are seeded into the fake store.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const PASSWORD = 'correct horse battery staple';
const INVITEE = 'New.Staff@Example.com';
const NAME = 'Noor Staff';
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
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const OWNER = accountId(1);
const OWNER2 = accountId(2);
const MANAGER = accountId(3);
const OTHER_OWNER = accountId(4);
const OTHER_MEMBER = accountId(5);
const ROOT = accountId(6);
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const OTHER_SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b002');
const MISSING = '01990000-0000-7000-8000-00000000ffff';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;
let deliveries = 0;

describe('seller team over HTTP (integration, slice 11)', () => {
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
  const roleOf = (code: string, scope: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
    )!.id;

  function seedSeller(
    code: string,
    sellerId: Id<'Seller'>,
    state: 'approved' | 'pending' = 'approved',
  ) {
    fakes.seedSellerAccess({
      sellerId,
      marketId: code as AccountState['marketId'],
      origin: 'self',
      state,
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 1,
      createdAt: START,
    });
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'team-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: 'admin' | 'seller') =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });
    const assign = (n: number, idOf: Id<'Account'>, roleId: Id<'Role'>) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    seedSeller(code, SELLER_ID);
    seedSeller(code, OTHER_SELLER_ID);
    for (const [n, idOf, seller, seedCode] of [
      [1, OWNER, SELLER_ID, 'seller-owner'],
      [2, OWNER2, SELLER_ID, 'seller-owner'],
      [3, MANAGER, SELLER_ID, 'store-manager'],
      [4, OTHER_OWNER, OTHER_SELLER_ID, 'seller-owner'],
      [5, OTHER_MEMBER, OTHER_SELLER_ID, 'store-manager'],
    ] as const) {
      account(n, idOf, 'seller');
      fakes.seedMembership({
        id: id<'SellerMembership'>(`01990000-0000-7000-8000-${n12(0xe000 + n)}`),
        marketId,
        accountId: idOf,
        sellerId: seller,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
      assign(n, idOf, roleOf(code, 'seller', seedCode));
    }
    account(6, ROOT, 'admin');
    assign(6, ROOT, roleOf(code, 'platform', 'platform-administrator'));
  }

  let sessions = 0;
  function sessionOf(
    code: string,
    account: Id<'Account'>,
    population: 'admin' | 'seller' = 'seller',
    sellerId: Id<'Seller'> = SELLER_ID,
  ) {
    const issued = tokens.issue();
    sessions += 1;
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + sessions)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        sellerId: population === 'seller' ? sellerId : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const call = (
    method: 'get' | 'post',
    code: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const pending = http()
      [method](`/identity/seller/team${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });
    return body === undefined ? pending : pending.send(body as object);
  };
  const codeOf = (response: request.Response) => (response.body as { code: string }).code;

  async function invitationMailed(code: string): Promise<string> {
    const event = fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1').at(-1)!;
    const sent = await app
      .get(SendInvitationMail)
      .execute(testCallContext(marketOf(code), 'system', 'team-mail-0001'), {
        delivery: {
          eventId: `0199eeee-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
          subscriber: 'identity.invitation-mail',
          attempt: 1,
        },
        invitationId: (event.payload as { invitationId: Id }).invitationId,
        aggregateVersion: event.aggregateVersion,
      });
    expect(sent).toMatchObject({ ok: true, value: { code: 'invitation-mail.sent' } });
    expect(fakes.mails.at(-1)!.text).toContain(`${ACCEPT_PAGES[code]}#`);
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    sessions = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the six routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = (path: string) => Object.keys(document.paths[path] ?? {}).sort();

    expect(methods('/identity/seller/team')).toEqual(['get']);
    expect(methods('/identity/seller/team/invitations')).toEqual(['post']);
    expect(methods('/identity/seller/team/invitations/{invitationId}/resend')).toEqual(['post']);
    expect(methods('/identity/seller/team/invitations/{invitationId}/revoke')).toEqual(['post']);
    expect(methods('/identity/seller/team/accounts/{accountId}/role')).toEqual(['post']);
    expect(methods('/identity/seller/team/accounts/{accountId}/remove')).toEqual(['post']);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists members and invitations of the own shop only, with hints; no-store', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      await call('post', code, '/invitations', owner, {
        email: INVITEE,
        roleId: roleOf(code, 'seller', 'catalogue-stock'),
      }).expect(201);

      const listed = await call('get', code, '', owner);

      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      const page = listed.body as {
        items: { type: string; accountId?: string; email: string; self?: boolean }[];
        next: string | null;
      };
      expect(page.next).toBeNull();
      expect(
        page.items
          .filter((i) => i.type === 'account')
          .map((i) => i.accountId!)
          .sort(),
      ).toEqual([OWNER, OWNER2, MANAGER].sort());
      expect(page.items.filter((i) => i.type === 'invitation')).toHaveLength(1);
      expect(page.items.find((i) => i.accountId === OWNER)).toMatchObject({ self: true });
      expect(JSON.stringify(page)).not.toContain('person4@');
      expect(JSON.stringify(page)).not.toMatch(/passwordHash|token/i);

      const bad = await call('get', code, '?seller=x', owner);
      expect([bad.status, codeOf(bad)]).toEqual([400, 'validation.failed']);
    });

    it('invites a Staff member, mails E10, and the invitee accepts with a name and joins', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const roleId = roleOf(code, 'seller', 'catalogue-stock');

      const issued = await call('post', code, '/invitations', owner, { email: INVITEE, roleId });
      expect(issued.status).toBe(201);
      expect(issued.body).toEqual({
        code: 'invitation.issued',
        invitationId: expect.any(String) as string,
      });
      const token = await invitationMailed(code);

      const noName = await http()
        .post('/identity/seller/accept-invitation')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send({ token, password: PASSWORD });
      expect([noName.status, codeOf(noName)]).toEqual([400, 'validation.failed']);
      const accepted = await http()
        .post('/identity/seller/accept-invitation')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send({ token, password: PASSWORD, displayName: NAME });
      expect([accepted.status, accepted.body]).toEqual([200, { code: 'invitation.accepted' }]);

      const joined = [...fakes.accounts.values()].find(
        (a) => a.email.normalized === INVITEE.toLowerCase(),
      )!;
      expect(joined).toMatchObject({ population: 'seller', displayName: NAME });
      expect([...fakes.memberships.values()].find((m) => m.accountId === joined.id)).toMatchObject({
        sellerId: SELLER_ID,
        state: 'active',
      });
      expect([...fakes.assignments.values()].find((a) => a.accountId === joined.id)).toMatchObject({
        roleId,
        assignedByAccountId: OWNER,
      });
      const replay = await http()
        .post('/identity/seller/accept-invitation')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send({ token, password: PASSWORD, displayName: NAME });
      expect([replay.status, codeOf(replay)]).toEqual([400, 'invitation.rejected']);
    });

    it('re-sends and revokes a pending invitation; the old link stops working', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const issued = await call('post', code, '/invitations', owner, {
        email: INVITEE,
        roleId: roleOf(code, 'seller', 'catalogue-stock'),
      });
      const { invitationId } = issued.body as { invitationId: string };
      const token = await invitationMailed(code);

      const resent = await call('post', code, `/invitations/${invitationId}/resend`, owner, {});
      expect([resent.status, resent.body]).toEqual([
        200,
        { code: 'invitation.reissued', invitationId },
      ]);
      const revoked = await call('post', code, `/invitations/${invitationId}/revoke`, owner, {});
      expect([revoked.status, revoked.body]).toEqual([
        200,
        { code: 'invitation.revoked', invitationId },
      ]);

      const accept = await http()
        .post('/identity/seller/accept-invitation')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send({ token, password: PASSWORD, displayName: NAME });
      expect([accept.status, codeOf(accept)]).toEqual([400, 'invitation.rejected']);
      const again = await call('post', code, `/invitations/${invitationId}/revoke`, owner, {});
      expect(again.status).toBeGreaterThanOrEqual(404);
    });

    it('changes a role, and answers role.unchanged for the same one', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const roleId = roleOf(code, 'seller', 'catalogue-stock');

      const changed = await call('post', code, `/accounts/${MANAGER}/role`, owner, { roleId });
      expect([changed.status, changed.body]).toEqual([
        200,
        { code: 'role.assigned', accountId: MANAGER, roleId },
      ]);
      const same = await call('post', code, `/accounts/${MANAGER}/role`, owner, { roleId });
      expect(same.body).toEqual({ code: 'role.unchanged', accountId: MANAGER, roleId });
      expect([...fakes.assignments.values()].find((a) => a.accountId === MANAGER)?.roleId).toBe(
        roleId,
      );
    });

    it('removes a member: its sessions end at once; the owner stays signed in', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const manager = sessionOf(code, MANAGER);
      expect((await call('get', code, '', manager)).status).toBe(200);

      const removed = await call('post', code, `/accounts/${MANAGER}/remove`, owner, {});
      expect([removed.status, removed.body]).toEqual([
        200,
        { code: 'member.removed', accountId: MANAGER },
      ]);

      const after = await call('get', code, '', manager);
      expect([after.status, codeOf(after)]).toEqual([401, 'session.invalid']);
      expect((await call('get', code, '', owner)).status).toBe(200);
      const rows = (await call('get', code, '', owner)).body as { items: { accountId?: string }[] };
      expect(rows.items.map((i) => i.accountId)).not.toContain(MANAGER);
      expect(logLines.find((l) => l.msg === 'identity.remove-team-member')).toMatchObject({
        marketId: code,
      });
      expect(JSON.stringify(logLines)).not.toContain('person3@');
    });

    it('treats another shop as unknown, byte-identical to a missing one (R6)', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const roleId = roleOf(code, 'seller', 'catalogue-stock');

      for (const target of [OTHER_MEMBER, OTHER_OWNER, MISSING]) {
        const role = await call('post', code, `/accounts/${target}/role`, owner, { roleId });
        const remove = await call('post', code, `/accounts/${target}/remove`, owner, {});
        expect([role.status, role.body]).toEqual([
          404,
          { statusCode: 404, code: 'account.unknown' },
        ]);
        expect([remove.status, remove.body]).toEqual([
          404,
          { statusCode: 404, code: 'account.unknown' },
        ]);
      }
      const foreignRole = await call('post', code, `/accounts/${MANAGER}/role`, owner, {
        roleId: MISSING,
      });
      expect([foreignRole.status, codeOf(foreignRole)]).toEqual([404, 'role.unknown']);
      expect([...fakes.memberships.values()].filter((m) => m.state === 'active')).toHaveLength(5);
    });

    it('refuses staff without the keys, an unapproved shop, a platform admin and no session', async () => {
      await boot();
      await seeded(code);
      const manager = sessionOf(code, MANAGER);
      const roleId = roleOf(code, 'seller', 'catalogue-stock');

      const asStaff = await call('post', code, '/invitations', manager, { email: INVITEE, roleId });
      expect([asStaff.status, codeOf(asStaff)]).toEqual([403, 'access.denied']);
      const removeAsStaff = await call('post', code, `/accounts/${OWNER2}/remove`, manager, {});
      expect([removeAsStaff.status, codeOf(removeAsStaff)]).toEqual([403, 'access.denied']);

      expect((await call('get', code, '', {})).status).toBe(401);
      expect((await call('get', code, '', sessionOf(code, ROOT, 'admin'))).status).toBe(401);

      seedSeller(code, SELLER_ID, 'pending');
      const owner = sessionOf(code, OWNER);
      const unapproved = await call('post', code, '/invitations', owner, {
        email: INVITEE,
        roleId,
      });
      expect([unapproved.status, codeOf(unapproved)]).toEqual([403, 'access.seller-not-approved']);
      expect(fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1')).toEqual([]);
    });

    it('refuses a role the actor may not grant, and the owner role to a Staff invitation', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);

      const ownerRole = await call('post', code, '/invitations', owner, {
        email: INVITEE,
        roleId: roleOf(code, 'seller', 'seller-owner'),
      });
      expect(ownerRole.status).toBeGreaterThanOrEqual(400);
      expect(['role.not-grantable', 'role.unknown', 'validation.failed']).toContain(
        codeOf(ownerRole),
      );
      const platformRole = await call('post', code, '/invitations', owner, {
        email: INVITEE,
        roleId: roleOf(code, 'platform', 'viewer'),
      });
      expect([platformRole.status, codeOf(platformRole)]).toEqual([404, 'role.unknown']);
      expect(fakes.invitations.size).toBe(0);
    });

    it('validates bodies, ids and content type; needs the CSRF token', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const roleId = roleOf(code, 'seller', 'catalogue-stock');

      const cases: [string, () => request.Test, number, string][] = [
        [
          'bad email',
          () => call('post', code, '/invitations', owner, { email: 'nope', roleId }),
          400,
          'validation.failed',
        ],
        [
          'unknown field',
          () =>
            call('post', code, '/invitations', owner, {
              email: INVITEE,
              roleId,
              sellerId: OTHER_SELLER_ID,
            }),
          400,
          'validation.failed',
        ],
        [
          'malformed invitation id',
          () => call('post', code, '/invitations/not-an-id/revoke', owner, {}),
          404,
          'invitation.unknown',
        ],
        [
          'unknown invitation',
          () => call('post', code, `/invitations/${MISSING}/resend`, owner, {}),
          404,
          'invitation.unknown',
        ],
        [
          'malformed account id',
          () => call('post', code, '/accounts/not-an-id/remove', owner, {}),
          404,
          'account.unknown',
        ],
        [
          'role without roleId',
          () => call('post', code, `/accounts/${MANAGER}/role`, owner, {}),
          400,
          'validation.failed',
        ],
      ];
      for (const [name, pending, status, errorCode] of cases) {
        const response = await pending();
        expect([name, response.status, codeOf(response)]).toEqual([name, status, errorCode]);
      }
      const text = await http()
        .post('/identity/seller/team/invitations')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...owner })
        .type('text/plain')
        .send('{}');
      expect(text.status).toBe(415);
      const noCsrf = await call(
        'post',
        code,
        `/accounts/${MANAGER}/remove`,
        { cookie: owner.cookie },
        {},
      );
      expect([noCsrf.status, noCsrf.body]).toEqual([
        403,
        { statusCode: 403, code: 'request.csrf' },
      ]);
      expect([...fakes.memberships.values()].find((m) => m.accountId === MANAGER)?.state).toBe(
        'active',
      );
    });

    it('logs each outcome with the correlation id and never an address', async () => {
      await boot();
      await seeded(code);
      const owner = sessionOf(code, OWNER);
      const issued = await call('post', code, '/invitations', owner, {
        email: INVITEE,
        roleId: roleOf(code, 'seller', 'catalogue-stock'),
      });

      const correlationId = issued.headers['x-correlation-id'] as string;
      expect(logLines.find((l) => l.msg === 'identity.invite-staff')).toMatchObject({
        outcome: 'invitation.issued',
        marketId: code,
        correlationId,
      });
      expect(JSON.stringify(logLines).toLowerCase()).not.toContain(INVITEE.toLowerCase());
    });
  });
});
