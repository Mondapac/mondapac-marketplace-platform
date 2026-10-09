import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin seller list over HTTP (identity design 8.6 rows 2, 6 and 8; `ux.md` P1; slice 9b):
// `GET /identity/admin/sellers` with the real guards, controller, gate and use case, identity's
// database ports as in-memory fakes and a fixed clock. Sessions are seeded into the fake store.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ROOT = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const SUPPORT_NO_KEY = id<'Account'>(0xa003);
const CUSTOMER = id<'Account'>(0xa004);
const OWNER_PENDING = id<'Account'>(0xa101);
const OWNER_APPROVED = id<'Account'>(0xa102);
const S_PENDING = id<'Seller'>(0xb010);
const S_APPROVED = id<'Seller'>(0xb020);
const INVITATION = id<'Invitation'>(0xb035);
const S_INVITED = id<'Seller'>(0xb060);
const NO_KEY_ROLE = id<'Role'>(0xc0ff);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('admin seller list over HTTP (integration, slice 9b)', () => {
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

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'list-0001'), {});
    const marketId = code as AccountState['marketId'];
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      permissionKeys: ['identity.admin-account.view'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    const account = (
      accountId: Id<'Account'>,
      population: AccountState['population'],
      label: string,
      roleId: Id<'Role'> | null,
    ) => {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label.toLowerCase()}@example.com` },
        displayName: population === 'customer' ? null : `Name ${label}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      if (roleId === null) return;
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    account(ROOT, 'admin', 'root', roleOf(code, 'platform', 'platform-administrator'));
    account(VIEWER, 'admin', 'viewer', roleOf(code, 'platform', 'viewer'));
    account(SUPPORT_NO_KEY, 'admin', 'nokey', NO_KEY_ROLE);
    account(CUSTOMER, 'customer', 'customer', null);
    for (const [sellerId, ownerId, state, label] of [
      [S_PENDING, OWNER_PENDING, 'pending', 'owner-pending'],
      [S_APPROVED, OWNER_APPROVED, 'approved', 'owner-approved'],
    ] as const) {
      fakes.seedSellerAccess({
        sellerId,
        marketId,
        origin: 'self',
        state,
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: 3,
        createdAt: START,
      });
      account(ownerId, 'seller', label, roleOf(code, 'seller', 'seller-owner'));
      n += 1;
      fakes.seedMembership({
        id: id<'SellerMembership'>(0xf000 + n),
        marketId,
        accountId: ownerId,
        sellerId,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
    }
    fakes.seedSellerAccess({
      sellerId: S_INVITED,
      marketId,
      origin: 'invitation',
      state: 'pending',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 1,
      createdAt: START,
    });
    fakes.invitations.set(INVITATION, {
      id: INVITATION,
      marketId,
      kind: 'seller-owner',
      email: { typed: 'Invitee@Example.com', normalized: 'invitee@example.com' },
      displayName: 'Invitee Name',
      roleId: roleOf(code, 'seller', 'seller-owner'),
      sellerId: S_INVITED,
      invitedByAccountId: ROOT,
      tokenHash: new Uint8Array(32).fill(9),
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
    population: 'admin' | 'customer' | 'seller' = 'admin',
    sellerId: Id<'Seller'> | null = null,
  ): string {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        ...(sellerId === null ? {} : { sellerId }),
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return `__Host-session-${population}-${code}=${issued.token}`;
  }

  const sellers = (code: string, cookie: string | null, query = '') => {
    const call = http()
      .get(`/identity/admin/sellers${query}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return cookie === null ? call : call.set('cookie', cookie);
  };
  const rowIds = (body: unknown) =>
    (body as { items: { sellerId: string; invitationId?: string }[] }).items.map(
      (row) => row.invitationId ?? row.sellerId,
    );

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

    const operation = document.paths['/identity/admin/sellers']?.get;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining(
        ['limit', 'after', 'state', 'email'].map(
          (name): unknown => expect.objectContaining({ name, in: 'query' }) as unknown,
        ),
      ),
    );
    for (const schema of [
      'AdminSellerListPageView',
      'AdminSellerListSellerRowView',
      'AdminSellerListInvitationRowView',
      'AdminSellerListOwnerView',
    ]) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists sellers with their owner, the open invitation and hints; logs no address or name', async () => {
      await boot();
      await seeded(code);

      const listed = await sellers(code, cookieOf(code, ROOT, 1));

      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(rowIds(listed.body)).toEqual([S_PENDING, S_APPROVED, INVITATION]);
      const body = listed.body as { items: Record<string, unknown>[]; next: string | null };
      expect(body.next).toBeNull();
      expect(body.items[0]).toEqual({
        type: 'seller',
        sellerId: S_PENDING,
        origin: 'self',
        state: 'pending',
        stateChangedAt: START.toString(),
        reapplyLimitReached: false,
        owner: {
          accountId: OWNER_PENDING,
          email: 'owner-pending@Example.com',
          displayName: 'Name owner-pending',
        },
        actions: {
          approve: { allowed: true, code: null },
          reject: { allowed: true, code: null },
          suspend: { allowed: false, code: 'seller-access.wrong-state' },
          reinstate: { allowed: false, code: 'seller-access.wrong-state' },
        },
      });
      expect(body.items[2]).toEqual({
        type: 'invitation',
        invitationId: INVITATION,
        sellerId: S_INVITED,
        email: 'Invitee@Example.com',
        displayName: 'Invitee Name',
        status: 'pending',
        createdAt: START.toString(),
        expiresAt: START.add({ hours: 1 }).toString(),
        actions: {
          resend: { allowed: true, code: null },
          revoke: { allowed: true, code: null },
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/token|hash|secret|credential|reason/i);
      const correlationId = listed.headers['x-correlation-id'] as string;
      expect(logLines.find((l) => l.msg === 'identity.admin-list-sellers')).toMatchObject({
        outcome: 'ok',
        marketId: code,
        correlationId,
      });
      expect(logLines.find((l) => l.msg === 'identity.list-seller-accounts')).toMatchObject({
        outcome: 'seller-accounts.listed',
        sellers: 2,
        invitations: 1,
        marketId: code,
        correlationId,
      });
      const logged = JSON.stringify(logLines).toLowerCase();
      for (const personal of ['owner-pending', 'owner-approved', 'invitee', 'name ']) {
        expect(logged).not.toContain(personal);
      }
    });

    it('filters by state and finds an exact address; the searched address is never logged', async () => {
      await boot();
      await seeded(code);
      const cookie = cookieOf(code, VIEWER, 2);

      expect(rowIds((await sellers(code, cookie, '?state=approved')).body)).toEqual([S_APPROVED]);
      expect(rowIds((await sellers(code, cookie, '?state=invited')).body)).toEqual([INVITATION]);
      const found = await sellers(
        code,
        cookie,
        `?email=${encodeURIComponent(' Owner-Approved@EXAMPLE.com ')}`,
      );
      expect([found.status, rowIds(found.body)]).toEqual([200, [S_APPROVED]]);
      expect(rowIds((await sellers(code, cookie, '?email=invitee%40example.com')).body)).toEqual([
        INVITATION,
      ]);
      const partial = await sellers(code, cookie, '?email=owner-approved');
      expect([partial.status, partial.body]).toEqual([
        400,
        {
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'email', code: 'format' }] },
        },
      ]);
      // A view-only admin: every action access.denied.
      const items = (
        (await sellers(code, cookie)).body as { items: { actions: Record<string, unknown> }[] }
      ).items;
      for (const row of items) {
        for (const hint of Object.values(row.actions)) {
          expect(hint).toEqual({ allowed: false, code: 'access.denied' });
        }
      }
      expect(JSON.stringify(logLines).toLowerCase()).not.toContain('owner-approved');
    });

    it('refuses an admin without identity.seller-access.view (403 access.denied)', async () => {
      await boot();
      await seeded(code);

      const refused = await sellers(code, cookieOf(code, SUPPORT_NO_KEY, 3));

      expect([refused.status, refused.body]).toEqual([
        403,
        { statusCode: 403, code: 'access.denied' },
      ]);
      expect(refused.headers['cache-control']).toBe('no-store');
      expect(logLines.find((l) => l.msg === 'identity.admin-list-sellers')).toMatchObject({
        outcome: 'access.denied',
      });
    });

    it('refuses no session, a customer session and a seller session (populations)', async () => {
      await boot();
      await seeded(code);

      expect((await sellers(code, null)).status).toBe(401);
      expect((await sellers(code, cookieOf(code, CUSTOMER, 4, 'customer'))).status).toBe(401);
      expect(
        (await sellers(code, cookieOf(code, OWNER_APPROVED, 5, 'seller', S_APPROVED))).status,
      ).toBe(401);
      // An admin cookie carrying a seller's session is refused too.
      const forged = cookieOf(code, OWNER_APPROVED, 6, 'seller', S_APPROVED).replace(
        `session-seller-${code}`,
        `session-admin-${code}`,
      );
      expect((await sellers(code, forged)).status).toBe(401);
    });

    it("never lists another Market's sellers or invitations, nor answers another Market's session", async () => {
      await boot();
      await seeded(code);
      const other = TEST_MARKETS.find((c) => c !== code)!;
      const otherMarketId = other as AccountState['marketId'];
      const OTHER_SELLER = id<'Seller'>(0xb015);
      const OTHER_OWNER = id<'Account'>(0xa1ff);
      fakes.seedSellerAccess({
        ...fakes.sellerAccess.get(S_PENDING)!,
        sellerId: OTHER_SELLER,
        marketId: otherMarketId,
      });
      fakes.seedAccount({
        ...fakes.accounts.get(OWNER_PENDING)!,
        id: OTHER_OWNER,
        marketId: otherMarketId,
      });
      fakes.invitations.set(id<'Invitation'>(0xb036), {
        ...fakes.invitations.get(INVITATION)!,
        id: id<'Invitation'>(0xb036),
        marketId: otherMarketId,
      });

      const listed = await sellers(code, cookieOf(code, ROOT, 7));
      expect(rowIds(listed.body)).toEqual([S_PENDING, S_APPROVED, INVITATION]);
      // This Market's admin session does not open the other Market's list.
      expect((await sellers(other, cookieOf(code, ROOT, 8))).status).toBe(401);
    });

    it('pages with after and limit, and validates the closed query', async () => {
      await boot();
      await seeded(code);
      const cookie = cookieOf(code, ROOT, 1);

      const first = await sellers(code, cookie, '?limit=2');
      expect([first.status, rowIds(first.body)]).toEqual([200, [S_PENDING, S_APPROVED]]);
      const next = (first.body as { next: string }).next;
      expect(next).toBe(S_APPROVED);
      const second = await sellers(code, cookie, `?limit=2&after=${next}`);
      expect([rowIds(second.body), (second.body as { next: unknown }).next]).toEqual([
        [INVITATION],
        null,
      ]);
      expect((await sellers(code, cookie, '?limit=100')).status).toBe(200);

      for (const [query, path] of [
        ['?limit=0', 'limit'],
        ['?limit=101', 'limit'],
        ['?limit=abc', 'limit'],
        ['?limit=1&limit=2', 'limit'],
        ['?after=nope', 'after'],
        ['?state=frozen', 'state'],
        ['?state=pending&state=approved', 'state'],
        ['?email=a%40b.c&email=d%40e.f', 'email'],
        ['?page=2', 'page'],
        ['?sellerId=x', 'sellerId'],
      ] as const) {
        const refused = await sellers(code, cookie, query);
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [expect.objectContaining({ path })] },
        });
      }
    });
  });
});
