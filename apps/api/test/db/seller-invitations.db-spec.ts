import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  INVITATION_REPOSITORY,
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../../src/modules/identity/application/ports/invitation.repository';
import {
  INVITATION_TOKENS,
  type OpaqueTokens,
} from '../../src/modules/identity/application/ports/second-factor-tokens';
import {
  LINK_TARGETS,
  type LinkTargets,
} from '../../src/modules/identity/application/ports/link-secrets';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from '../../src/modules/identity/application/ports/seller-access.repository';
import { AcceptSellerInvitation } from '../../src/modules/identity/application/use-cases/accept-seller-invitation.use-case';
import { InviteSeller } from '../../src/modules/identity/application/use-cases/invite-seller.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { parseEmailAddress } from '../../src/modules/identity/domain/email-address';
import { Invitation } from '../../src/modules/identity/domain/invitation';
import { SellerAccess } from '../../src/modules/identity/domain/seller-access';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 9 on PostgreSQL, round 1 of PR #204 (Hassan M2; data design 3.10), for both
// Market fixtures: two acceptances of one seller-owner invitation racing under SERIALIZABLE
// create exactly one account (one success, one `invitation.rejected`), and the partial unique key
// keeps one pending seller-owner invitation per address in the Market.

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };

/** The seller acceptance page the Market configuration does not carry yet. */
function withSellerAcceptPage(markets: MarketRegistry): LinkTargets {
  const base = new MarketConfigIdentityPolicy(markets);
  return {
    target: (m: MarketContext, population, page) =>
      population === 'seller' && page === 'accept-invitation'
        ? 'https://seller.example.test/accept-invitation'
        : base.target(m, population, page),
  };
}

describe.each(TEST_MARKETS)('seller-owner invitations in market %s (database, slice 9)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let unitOfWork: UnitOfWork;
  let invitations: InvitationRepository;
  let sellers: SellerAccessRepository;
  let tokens: OpaqueTokens;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl() },
      override: (builder) =>
        builder
          .overrideProvider(LINK_TARGETS)
          .useFactory({ factory: withSellerAcceptPage, inject: [MarketRegistry] }),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    unitOfWork = app.get(UNIT_OF_WORK, { strict: false });
    invitations = app.get(INVITATION_REPOSITORY, { strict: false });
    sellers = app.get(SELLER_ACCESS_REPOSITORY, { strict: false });
    tokens = app.get(INVITATION_TOKENS, { strict: false });
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-invitations-${randomUUID()}`), {});
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const inUnit = <T>(m: MarketContext, work: () => Promise<T>): Promise<T> =>
    unitOfWork
      .run(m, async () => ok(await work()))
      .then((result) => (result as { ok: true; value: T }).value);

  const roleId = async (scope: string, seedCode: string): Promise<Id<'Role'>> => {
    const { rows } = await sql.query<{ id: Id<'Role'> }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = $2 AND seed_code = $3`,
      [code, scope, seedCode],
    );
    return rows[0]!.id;
  };

  /** An active, verified admin holding `identity.seller-account.create` (the inviter). */
  async function inviter(): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `inviter.${id}@invitations.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version,
       created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $3, 'Inviter', 'active', now(), now(), 1, now())`,
      [id, code, email],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, now())`,
      [code, id, PASSWORD_HASH],
    );
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, now(), 1)`,
      [newId(), code, id, await roleId('platform', 'onboarding-compliance')],
    );
    return id;
  }

  /** A registered seller without members, invited at `email`; answers the dispatched token. */
  async function invited(email: string, invitedBy: Id<'Account'>) {
    const now = Temporal.Now.instant();
    const access = SellerAccess.forInvitation({
      sellerId: newId<'Seller'>(),
      marketId: market.marketId,
      approvalRequired: true,
      now,
    });
    const parsed = parseEmailAddress(email);
    if (!parsed.ok) throw new Error('fixture address');
    const invitation = Invitation.issue({
      id: newId<'Invitation'>(),
      marketId: market.marketId,
      kind: 'seller-owner',
      email: parsed.value,
      displayName: 'Amina Rahman',
      roleId: await roleId('seller', 'seller-owner'),
      sellerId: access.state.sellerId,
      invitedByAccountId: invitedBy,
      now,
    });
    await inUnit(market, async () => {
      await sellers.add(market, access);
      await invitations.add(market, invitation);
    });
    const issued = tokens.issue();
    await inUnit(market, async () => {
      const stored = (await invitations.findById(market, invitation.state.id))!;
      if (!stored.dispatch(issued.tokenHash, now, 60).ok) throw new Error('dispatch');
      await invitations.save(market, stored);
    });
    return { token: issued.token, sellerId: access.state.sellerId, invitation };
  }

  it('lets exactly one of two parallel acceptances create the owner account (Hassan M2)', async () => {
    const email = `owner.${randomUUID()}@invitations.example`;
    const { token, sellerId } = await invited(email, await inviter());
    const accept = () =>
      app.get(AcceptSellerInvitation).execute(testCallContext(market, 'anonymous'), {
        token,
        password: PASSWORD,
        client: CLIENT,
      });

    const results = await Promise.all([accept(), accept()]);

    const outcomes = results.map((r) => (r.ok ? r.value.code : r.error.code)).sort();
    expect(outcomes).toEqual(['invitation.accepted', 'invitation.rejected']);
    const accounts = await sql.query<{ id: string }>(
      `SELECT id FROM identity.accounts WHERE market_id = $1 AND email_normalized = $2`,
      [code, email],
    );
    expect(accounts.rows).toHaveLength(1);
    const members = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM identity.seller_memberships WHERE market_id = $1 AND seller_id = $2`,
      [code, sellerId],
    );
    expect(members.rows[0]!.n).toBe('1');
  });

  it('keeps one pending seller-owner invitation per address in the Market (data design 3.10)', async () => {
    const admin = await inviter();
    const email = `twice.${randomUUID()}@invitations.example`;
    await invited(email, admin);

    await expect(invited(email.toUpperCase(), admin)).rejects.toBeInstanceOf(
      InvitationAlreadyPendingError,
    );
  });

  it('lets one of two InviteSeller calls for one address win; no second seller survives (Mojtaba, round 2)', async () => {
    const admin = await inviter();
    const email = `racing.${randomUUID()}@invitations.example`;
    const added: Id<'Seller'>[] = [];
    // InviteSeller uses this same repository instance: record every seller it adds.
    const original = sellers.add.bind(sellers);
    const add = jest.spyOn(sellers, 'add').mockImplementation((m, access) => {
      added.push(access.state.sellerId);
      return original(m, access);
    });
    const as = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: admin,
          sessionId: newId<'Session'>(),
          sellerId: null,
        }),
        `db-invite-${randomUUID()}`,
      );
    const invite = () =>
      app
        .get(InviteSeller)
        .execute(as(), { email, displayName: 'Amina Rahman', origin: CLIENT.origin });

    let results;
    try {
      results = await Promise.all([invite(), invite()]);
    } finally {
      add.mockRestore();
    }

    const outcomes = results.map((r) => (r.ok ? r.value.code : r.error.code)).sort();
    expect(outcomes).toEqual(['invitation.already-pending', 'invitation.issued']);
    const winner = results.find((r) => r.ok)!;
    const { rows } = await sql.query<{ seller_id: string }>(
      `SELECT seller_id FROM identity.seller_access WHERE market_id = $1 AND seller_id = ANY($2)`,
      [code, added],
    );
    expect(rows.map((r) => r.seller_id)).toEqual([
      (winner as { ok: true; value: { sellerId: string } }).value.sellerId,
    ]);
    const pending = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM identity.invitations
       WHERE market_id = $1 AND email_normalized = $2 AND state = 'pending'`,
      [code, email],
    );
    expect(pending.rows[0]!.n).toBe('1');
  });
});
