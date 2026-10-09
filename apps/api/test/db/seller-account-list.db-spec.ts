import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  ListSellerAccounts,
  type SellerListRow,
  type SellerListSellerRow,
} from '../../src/modules/identity/application/use-cases/list-seller-accounts.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import {
  SELLER_ACCESS_CONTRACT,
  type SellerAccessContract,
} from '../../src/modules/identity/contracts/seller-access.contract';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf, recordDriverStatements } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 9b on PostgreSQL (identity design 8.1 `sellerAccountSummaries`, 8.6 row 8), for
// both Market fixtures, as the application role on the run database: the admin seller list and
// the summaries through the real gate, use cases and Prisma read, in read-only units with no
// transaction (ADR-0025). The Seller Owner is found in `identity`'s own tables only; no
// statement touches the `sellers` schema (Hassan). Other files add sellers to the same Markets
// meanwhile, so each case pages through this file's id range and looks at its own rows only.

const CREATED = '2026-10-08T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('the admin seller list in market %s (database, slice 9b)', (code) => {
  const market = marketOf(code);
  const otherCode = otherMarketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let contract: SellerAccessContract;
  let driver: ReturnType<typeof recordDriverStatements>;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    contract = app.get(SELLER_ACCESS_CONTRACT, { strict: false });
    driver = recordDriverStatements();
    for (const each of [market, marketOf(otherCode)]) {
      await app
        .get(SeedRoles)
        .execute(testCallContext(each, 'system', `db-seller-list-${randomUUID()}`), {});
    }
  });
  afterAll(async () => {
    driver.restore();
    await sql.end();
    await app.close();
  });
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));
  const logged = () => JSON.stringify(logs.flatMap((spy) => spy.mock.calls as unknown[]));

  async function roleId(
    scope: 'platform' | 'seller',
    seedCode: string,
    marketCode: string = code,
  ): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = $2 AND seed_code = $3`,
      [marketCode, scope, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  /** An account; `label` makes its address. Unverified when `verified` is false. */
  async function account(
    population: 'admin' | 'seller',
    options: {
      marketCode?: string;
      verified?: boolean;
      role?: Id<'Role'> | null;
      address?: string;
    } = {},
  ): Promise<{ id: Id<'Account'>; email: string }> {
    const marketCode = options.marketCode ?? code;
    const id = newId<'Account'>();
    const email = options.address ?? `Person.${id}@Sellers.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, 'active', $7, $8, 1, $8)`,
      [
        id,
        marketCode,
        population,
        email,
        email.toLowerCase(),
        `Name ${id.slice(-6)}`,
        options.verified === false ? null : CREATED,
        CREATED,
      ],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [marketCode, id, PASSWORD_HASH, CREATED],
    );
    if (options.role !== null && options.role !== undefined) {
      await sql.query(
        `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
         assigned_by_account_id, assigned_at, version)
         VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
        [newId(), marketCode, id, options.role, CREATED],
      );
    }
    return { id, email };
  }

  async function seller(
    state: 'pending' | 'approved' | 'rejected' | 'suspended',
    options: { marketCode?: string; origin?: 'self' | 'invitation'; registered?: boolean } = {},
  ): Promise<Id<'Seller'>> {
    const id = newId<'Seller'>();
    await sql.query(
      `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
       state_changed_at, reapply_count, registered_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, 0, $6, 1, $5)`,
      [
        id,
        options.marketCode ?? code,
        options.origin ?? 'self',
        state,
        CREATED,
        options.registered === false ? null : CREATED,
      ],
    );
    return id;
  }

  async function member(
    sellerId: Id<'Seller'>,
    accountId: Id<'Account'>,
    marketCode: string = code,
  ): Promise<void> {
    await sql.query(
      `INSERT INTO identity.seller_memberships (id, market_id, tenant_id, account_id, seller_id,
       state, removed_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, 'active', NULL, 1, $5)`,
      [newId(), marketCode, accountId, sellerId, CREATED],
    );
  }

  /** A seller with an owner (verified unless said otherwise), as a sign-up or an acceptance. */
  async function ownedSeller(
    state: 'pending' | 'approved' | 'rejected' | 'suspended',
    options: { marketCode?: string; verified?: boolean; registered?: boolean } = {},
  ) {
    const marketCode = options.marketCode ?? code;
    const sellerId = await seller(state, { marketCode, registered: options.registered });
    const owner = await account('seller', {
      marketCode,
      verified: options.verified,
      role: await roleId('seller', 'seller-owner', marketCode),
    });
    await member(sellerId, owner.id, marketCode);
    return { sellerId, owner };
  }

  async function ownerInvitation(
    sellerId: Id<'Seller'>,
    invitedBy: Id<'Account'>,
    marketCode: string = code,
  ): Promise<{ id: Id<'Invitation'>; email: string }> {
    const id = newId<'Invitation'>();
    const email = `Invitee.${id}@Sellers.example`;
    await sql.query(
      `INSERT INTO identity.invitations (id, market_id, tenant_id, kind, email, email_normalized,
       display_name, role_id, seller_id, invited_by_account_id, token_hash, expires_at, state,
       decided_at, accepted_account_id, version, created_at)
       VALUES ($1, $2, 'default', 'seller-owner', $3, $4, 'Invitee Name', $5, $6, $7, $8, $9,
       'pending', NULL, NULL, 2, $10)`,
      [
        id,
        marketCode,
        email,
        email.toLowerCase(),
        await roleId('seller', 'seller-owner', marketCode),
        sellerId,
        invitedBy,
        randomBytes(32),
        // The use case reads the real clock: created now, its mail valid for another hour.
        new Date(Date.now() + 3_600_000).toISOString(),
        new Date().toISOString(),
      ],
    );
    return { id, email };
  }

  const as = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId: null,
      }),
      `db-seller-list-${randomUUID()}`,
    );

  /** Every row of the list in this file's id range, page by page. */
  async function everyRow(
    actor: Id<'Account'>,
    query: { limit?: number; state?: string; email?: string } = {},
  ): Promise<SellerListRow[]> {
    const list = app.get(ListSellerAccounts);
    const rows: SellerListRow[] = [];
    let after: string | null = `${ID_PREFIX}000000000000`;
    for (let pages = 0; pages < 1000; pages += 1) {
      const result = await list.execute(as(actor), { limit: 100, ...query, after });
      if (!result.ok) throw new Error(`listed: ${result.error.code}`);
      rows.push(...result.value.items);
      after = result.value.next;
      if (after === null || after > `${ID_PREFIX}ffffffffffff`) break;
    }
    return rows;
  }
  const rowId = (row: SellerListRow) => (row.type === 'seller' ? row.sellerId : row.invitationId);

  it("lists this Market's owned sellers and open invitations by id, with their owner and hints", async () => {
    const compliance = await account('admin', {
      role: await roleId('platform', 'onboarding-compliance'),
    });
    const pending = await ownedSeller('pending');
    const approved = await ownedSeller('approved');
    const staff = await account('seller', { role: await roleId('seller', 'store-manager') });
    await member(approved.sellerId, staff.id);
    const unverified = await ownedSeller('pending', { verified: false, registered: false });
    const invited = await seller('pending', { origin: 'invitation' });
    const invitation = await ownerInvitation(invited, compliance.id);
    const orphan = await seller('pending', { origin: 'invitation' });
    const elsewhere = await ownedSeller('approved', { marketCode: otherCode });
    const elsewhereAdmin = await account('admin', {
      marketCode: otherCode,
      role: await roleId('platform', 'onboarding-compliance', otherCode),
    });
    const elsewhereInvitation = await ownerInvitation(
      await seller('pending', { marketCode: otherCode, origin: 'invitation' }),
      elsewhereAdmin.id,
      otherCode,
    );

    // Pages of 2 rows, so this file's rows cross page boundaries.
    const rows = await everyRow(compliance.id, { limit: 2 });

    const ids = rows.map(rowId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    const mine = [pending.sellerId, approved.sellerId, invitation.id] as string[];
    expect(ids.filter((id) => mine.includes(id))).toEqual([...mine].sort());
    for (const absent of [
      unverified.sellerId,
      invited,
      orphan,
      elsewhere.sellerId,
      elsewhereInvitation.id,
    ]) {
      expect(ids).not.toContain(absent);
    }
    const sellerRow = (id: string) => rows.find((row) => rowId(row) === id) as SellerListSellerRow;
    expect(sellerRow(approved.sellerId)).toMatchObject({
      state: 'approved',
      owner: { accountId: approved.owner.id, email: approved.owner.email },
      actions: {
        approve: { allowed: false, code: 'seller-access.wrong-state' },
        suspend: { allowed: true, code: null },
      },
    });
    expect(sellerRow(pending.sellerId).actions.approve).toEqual({ allowed: true, code: null });
    expect(rows.find((row) => rowId(row) === invitation.id)).toMatchObject({
      type: 'invitation',
      sellerId: invited,
      email: invitation.email,
      displayName: 'Invitee Name',
      status: 'pending',
      actions: { resend: { allowed: true, code: null }, revoke: { allowed: true, code: null } },
    });
    expect(logged()).not.toMatch(/@sellers\.example|Invitee Name|Name [0-9a-f]{6}/i);
  });

  it('filters by state and finds an exact address only: the owner or the invitee, never a staff member', async () => {
    const viewer = await account('admin', { role: await roleId('platform', 'viewer') });
    const compliance = await account('admin', {
      role: await roleId('platform', 'onboarding-compliance'),
    });
    const suspended = await ownedSeller('suspended');
    const staff = await account('seller', { role: await roleId('seller', 'store-manager') });
    await member(suspended.sellerId, staff.id);
    const invited = await seller('pending', { origin: 'invitation' });
    const invitation = await ownerInvitation(invited, compliance.id);

    const bySuspended = (await everyRow(viewer.id, { state: 'suspended' })).map(rowId);
    expect(bySuspended).toContain(suspended.sellerId);
    expect(bySuspended).not.toContain(invitation.id);
    const byInvited = (await everyRow(viewer.id, { state: 'invited' })).map(rowId);
    expect(byInvited).toContain(invitation.id);
    expect(byInvited).not.toContain(suspended.sellerId);

    const search = async (email: string, state?: string) =>
      (await everyRow(viewer.id, { email, ...(state === undefined ? {} : { state }) })).map(rowId);
    expect(await search(`  ${suspended.owner.email.toUpperCase()} `)).toEqual([suspended.sellerId]);
    expect(await search(suspended.owner.email, 'pending')).toEqual([]);
    expect(await search(invitation.email.toLowerCase())).toEqual([invitation.id]);
    expect(await search(staff.email)).toEqual([]);
    expect(await search('nobody.at.all@sellers.example')).toEqual([]);
    expect(logged()).not.toMatch(/@sellers\.example/i);
  });

  it("answers sellerAccountSummaries for this Market's registered sellers only, with the owner or null", async () => {
    const viewer = await account('admin', { role: await roleId('platform', 'viewer') });
    const approved = await ownedSeller('approved');
    const invited = await seller('pending', { origin: 'invitation' });
    const unregistered = await ownedSeller('pending', { verified: false, registered: false });
    const elsewhere = await ownedSeller('approved', { marketCode: otherCode });

    const result = await contract.sellerAccountSummaries(as(viewer.id), [
      approved.sellerId,
      invited,
      unregistered.sellerId,
      elsewhere.sellerId,
      newId<'Seller'>(),
    ]);

    if (!result.ok) throw new Error(result.error.code);
    const byId = new Map(result.value.map((summary) => [summary.sellerId as string, summary]));
    expect([...byId.keys()].sort()).toEqual([approved.sellerId, invited].sort());
    expect(byId.get(approved.sellerId)).toEqual({
      sellerId: approved.sellerId,
      state: 'approved',
      stateChangedAt: expect.anything() as unknown,
      owner: {
        accountId: approved.owner.id,
        displayName: `Name ${approved.owner.id.slice(-6)}`,
        email: approved.owner.email,
      },
    });
    expect(byId.get(invited)?.owner).toBeNull();
    // An admin account without a role holds no key: refused, nothing read.
    const keyless = await account('admin', { role: null });
    await expect(
      contract.sellerAccountSummaries(as(keyless.id), [approved.sellerId]),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(logged()).not.toMatch(/@sellers\.example/i);
  });

  it('runs in read-only units on identity tables only: SELECTs, the Market in each, no sellers schema', async () => {
    const compliance = await account('admin', {
      role: await roleId('platform', 'onboarding-compliance'),
    });
    const owned = await ownedSeller('pending');
    await ownerInvitation(await seller('pending', { origin: 'invitation' }), compliance.id);

    const listed = await driver.during(() =>
      app.get(ListSellerAccounts).execute(as(compliance.id), { limit: 100 }),
    );
    const listStatements = [...driver.statements];
    const searched = await driver.during(() =>
      app
        .get(ListSellerAccounts)
        .execute(as(compliance.id), { limit: 100, email: owned.owner.email }),
    );
    const searchStatements = [...driver.statements];
    const summaries = await driver.during(() =>
      contract.sellerAccountSummaries(as(compliance.id), [owned.sellerId]),
    );
    const summaryStatements = [...driver.statements];

    expect([listed.ok, searched.ok, summaries.ok]).toEqual([true, true, true]);
    for (const statement of [...listStatements, ...searchStatements, ...summaryStatements]) {
      expect(statement.trim()).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i);
      expect(statement.trim()).toMatch(/^SELECT/i);
      // Hassan: no join into `sellers`; identity reads only its own schema.
      expect(statement).not.toMatch(/"sellers"\./);
      // Mojtaba: every statement carries the Market in its predicate.
      expect(statement).toMatch(/"market_id"/);
    }
    // No token, factor secret or reason is read. (The actor's own account is re-read through
    // `AccountRepository.findById`, as in every admin read, which loads its credential row.)
    expect([...listStatements, ...searchStatements, ...summaryStatements].join('\n')).not.toMatch(
      /token_hash|secret_ciphertext|reason_ciphertext/,
    );
  });
});
