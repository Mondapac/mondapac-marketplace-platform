import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  ACCESS_DECISION_REPOSITORY,
  type AccessDecisionRepository,
  type StoredAccessDecision,
} from '../../src/modules/identity/application/ports/access-decision.repository';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from '../../src/modules/identity/application/ports/seller-access.repository';
import {
  SELLER_MEMBERSHIP_REPOSITORY,
  type SellerMembershipRepository,
} from '../../src/modules/identity/application/ports/seller-team.repository';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import type { AccessDecision } from '../../src/modules/identity/domain/access-decision';
import { SellerAccess } from '../../src/modules/identity/domain/seller-access';
import { openSession } from '../../src/modules/identity/domain/session';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../src/platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 9 on PostgreSQL (data design 3.11, 7, 8.1 migration #9; identity design 3.3,
// decision 9, HF13), for both Market fixtures, as the application role on the run database: the
// access decisions with their reasons encrypted under the seller's subject key, read back, the
// latest one per seller, a reason erased with the key; the table's CHECKs, foreign key and
// append-only privileges; and the new reads and writes of the slice (every session of a seller
// ends; a seller's active members).

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const REASON = 'Canary reason: the licence number does not match';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

describe.each(TEST_MARKETS)('access decisions in market %s (database, slice 9)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let app: NestExpressApplication;
  let sql: Client;
  let unitOfWork: UnitOfWork;
  let sellers: SellerAccessRepository;
  let decisions: AccessDecisionRepository;
  let sessions: SessionRepository;
  let memberships: SellerMembershipRepository;
  let keys: SubjectKeyService;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    unitOfWork = app.get(UNIT_OF_WORK, { strict: false });
    sellers = app.get(SELLER_ACCESS_REPOSITORY, { strict: false });
    decisions = app.get(ACCESS_DECISION_REPOSITORY, { strict: false });
    sessions = app.get(SESSION_REPOSITORY, { strict: false });
    memberships = app.get(SELLER_MEMBERSHIP_REPOSITORY, { strict: false });
    keys = app.get(SUBJECT_KEY_SERVICE, { strict: false });
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

  /** A seller created by an invitation (registered, waiting for approval), with its key. */
  async function seller(m: MarketContext = market): Promise<Id<'Seller'>> {
    const access = SellerAccess.forInvitation({
      sellerId: newId<'Seller'>(),
      marketId: m.marketId,
      approvalRequired: true,
      now: Temporal.Now.instant(),
    });
    await inUnit(m, () => sellers.add(m, access));
    return access.state.sellerId;
  }

  /** Applies one decision to the stored seller and records it, as the use cases do. */
  async function decide(
    sellerId: Id<'Seller'>,
    make: (access: SellerAccess, decisionId: Id<'AccessDecision'>) => AccessDecision,
  ): Promise<Id<'AccessDecision'>> {
    const decisionId = newId<'AccessDecision'>();
    await inUnit(market, async () => {
      const access = (await sellers.findById(market, sellerId))!;
      const decision = make(access, decisionId);
      await sellers.save(market, access);
      await decisions.add(market, decision);
    });
    return decisionId;
  }

  const read = (id: Id<'AccessDecision'>, m: MarketContext = market) =>
    inUnit(m, () => decisions.findById(m, id));
  const unwrap = <T>(result: { ok: boolean; value?: T }): T => {
    if (!result.ok) throw new Error('refused');
    return result.value as T;
  };

  it('stores a rejection reason only encrypted and reads it back; the approval carries none', async () => {
    const sellerId = await seller();
    const admin = newId<'Account'>();
    const basisId = newId();
    const t1 = Temporal.Now.instant();
    const rejected = await decide(sellerId, (access, decisionId) =>
      unwrap(access.reject({ decisionId, decidedBy: admin, now: t1, basisId, reason: REASON })),
    );

    const { rows } = await sql.query<{ reason_ciphertext: string; basis_id: string }>(
      `SELECT reason_ciphertext, basis_id FROM identity.access_decisions WHERE id = $1`,
      [rejected],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_ciphertext).not.toContain('licence');
    expect(rows[0]!.basis_id).toBe(basisId);
    await expect(read(rejected)).resolves.toEqual<StoredAccessDecision>({
      id: rejected,
      sellerId,
      decision: 'rejected',
      reason: REASON,
      reasonErased: false,
      basisId,
      decidedByAccountId: admin,
      decidedAt: expect.any(Temporal.Instant) as Temporal.Instant,
    });
    // Another Market never reads it (the Market guard).
    await expect(read(rejected, other)).resolves.toBeNull();
  });

  it('answers the latest decision of a seller, and an erased reason once the key is destroyed', async () => {
    const sellerId = await seller();
    const t0 = Temporal.Now.instant();
    await decide(sellerId, (access, decisionId) =>
      unwrap(access.approve({ decisionId, decidedBy: null, now: t0, basisId: null })),
    );
    const suspended = await decide(sellerId, (access, decisionId) =>
      unwrap(
        access.suspend({
          decisionId,
          decidedBy: null,
          now: t0.add({ seconds: 1 }),
          reason: REASON,
        }),
      ),
    );

    await expect(inUnit(market, () => decisions.latestOf(market, sellerId))).resolves.toMatchObject(
      { id: suspended, decision: 'suspended', reason: REASON },
    );
    await inUnit(market, () => keys.destroyKey(market, sellerId));
    await expect(read(suspended)).resolves.toMatchObject({ reason: null, reasonErased: true });
  });

  it('refuses a row that breaks the reason CHECK, an unknown seller, an update and a delete', async () => {
    const sellerId = await seller();
    const insert = (decision: string, cipher: string | null, sellerOf: string = sellerId) =>
      sql.query(
        `INSERT INTO identity.access_decisions (id, market_id, tenant_id, seller_id, decision,
         reason_ciphertext, basis_id, decided_by_account_id, decided_at)
         VALUES ($1, $2, 'default', $3, $4, $5, NULL, NULL, now())`,
        [randomUUID(), code, sellerOf, decision, cipher],
      );

    await expect(insert('approved', 'x')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('rejected', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('revoked', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('approved', null, randomUUID())).rejects.toMatchObject({ code: '23503' });
    await insert('approved', null);
    await expect(
      sql.query(`UPDATE identity.access_decisions SET decision = 'approved' WHERE seller_id = $1`, [
        sellerId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql.query(`DELETE FROM identity.access_decisions WHERE seller_id = $1`, [sellerId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it("ends every live session of the seller's accounts, once; reads the active members", async () => {
    const sellerId = await seller();
    const otherSellerId = await seller();
    const account = async (): Promise<Id<'Account'>> => {
      const id = newId<'Account'>();
      const email = `member.${id}@seller.example`;
      await sql.query(
        `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
         email_normalized, display_name, status, email_verified_at, signed_up_at, version,
         created_at)
         VALUES ($1, $2, 'default', 'seller', $3, $3, 'Member', 'active', now(), now(), 1, now())`,
        [id, code, email],
      );
      await sql.query(
        `INSERT INTO identity.password_credentials
           (market_id, tenant_id, account_id, password_hash, changed_at)
         VALUES ($1, 'default', $2, $3, now())`,
        [code, id, PASSWORD_HASH],
      );
      return id;
    };
    const member = async (accountId: Id<'Account'>, of: Id<'Seller'>, state = 'active') =>
      sql.query(
        `INSERT INTO identity.seller_memberships (id, market_id, tenant_id, account_id, seller_id,
         state, removed_at, version, created_at)
         VALUES ($1, $2, 'default', $3, $4, $5, $6, 1, now())`,
        [newId(), code, accountId, of, state, state === 'removed' ? new Date() : null],
      );
    const session = (accountId: Id<'Account'>, of: Id<'Seller'>) =>
      inUnit(market, () =>
        sessions.add(
          market,
          openSession({
            id: newId<'Session'>(),
            marketId: market.marketId,
            accountId,
            population: 'seller',
            sellerId: of,
            transport: 'cookie',
            lifetime: LIFETIME,
            now: Temporal.Now.instant(),
          }),
          randomBytes(32),
        ),
      );
    const [owner, staff, gone, outsider] = [
      await account(),
      await account(),
      await account(),
      await account(),
    ];
    await member(owner, sellerId);
    await member(staff, sellerId);
    await member(gone, sellerId, 'removed');
    await member(outsider, otherSellerId);
    await session(owner, sellerId);
    await session(staff, sellerId);
    await session(outsider, otherSellerId);

    await expect(
      inUnit(market, () => memberships.activeMembersOf(market, sellerId)).then((ids) =>
        [...ids].sort(),
      ),
    ).resolves.toEqual([owner, staff].sort());
    const now = Temporal.Now.instant();
    await expect(
      inUnit(market, () => sessions.revokeAllOfSeller(market, sellerId, 'seller-suspended', now)),
    ).resolves.toBe(2);
    await expect(
      inUnit(market, () => sessions.revokeAllOfSeller(market, sellerId, 'seller-suspended', now)),
    ).resolves.toBe(0);
    const { rows } = await sql.query<{ account_id: string; revoked_reason: string | null }>(
      `SELECT account_id, revoked_reason FROM identity.sessions WHERE account_id = ANY($1)`,
      [[owner, staff, outsider]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.account_id, r.revoked_reason]))).toEqual({
      [owner]: 'seller-suspended',
      [staff]: 'seller-suspended',
      [outsider]: null,
    });
  });
});
