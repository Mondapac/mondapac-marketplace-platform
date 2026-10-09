import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  ACCESS_DECISION_REPOSITORY,
  type AccessDecisionRepository,
} from '../../src/modules/identity/application/ports/access-decision.repository';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from '../../src/modules/identity/application/ports/seller-access.repository';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import {
  SELLER_ACCESS_CONTRACT,
  type SellerAccessContract,
} from '../../src/modules/identity/contracts/seller-access.contract';
import type { AccessDecision } from '../../src/modules/identity/domain/access-decision';
import { SellerAccess } from '../../src/modules/identity/domain/seller-access';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../src/platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 9a on PostgreSQL (identity design 8.1; sellers request R-5; Hassan C2, C5, C6),
// for both Market fixtures, as the application role on the run database, through the real
// seller-access contract: the admin read with its reasons opened under the seller's real subject
// key, an erased reason, a ciphertext that does not authenticate, the Market and seller
// isolation of both reads, and the index the reconciliation read stands on.

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const REASON = 'Canary 9a reason: permit 7719 is not this business';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;
const DECIDER = newId<'Account'>();

describe.each(TEST_MARKETS)(
  'R-5 access decision reads in market %s (database, slice 9a)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const system = testCallContext(market, 'system', `db-r5-${randomUUID()}`);
    let app: NestExpressApplication;
    let sql: Client;
    let unitOfWork: UnitOfWork;
    let sellers: SellerAccessRepository;
    let decisions: AccessDecisionRepository;
    let keys: SubjectKeyService;
    let contract: SellerAccessContract;
    let admin: CallContext;
    let logs: jest.SpyInstance[];

    const inUnit = <T>(m: MarketContext, work: () => Promise<T>): Promise<T> =>
      unitOfWork
        .run(m, async () => ok(await work()))
        .then((result) => (result as { ok: true; value: T }).value);

    /** An active, verified admin of this Market holding the onboarding role (and so the view key). */
    async function adminContext(): Promise<CallContext> {
      const { rows } = await sql.query<{ id: string }>(
        `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform'
       AND seed_code = 'onboarding-compliance'`,
        [code],
      );
      const id = newId<'Account'>();
      const email = `r5.${id}@decisions.example`;
      await sql.query(
        `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version,
       created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $3, 'Reviewer', 'active', now(), now(), 1, now())`,
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
        [newId(), code, id, rows[0]!.id],
      );
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: id,
          sessionId: newId<'Session'>(),
          sellerId: null,
        }),
        `db-r5-${randomUUID()}`,
      );
    }

    beforeAll(async () => {
      ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      unitOfWork = app.get(UNIT_OF_WORK, { strict: false });
      sellers = app.get(SELLER_ACCESS_REPOSITORY, { strict: false });
      decisions = app.get(ACCESS_DECISION_REPOSITORY, { strict: false });
      keys = app.get(SUBJECT_KEY_SERVICE, { strict: false });
      contract = app.get(SELLER_ACCESS_CONTRACT, { strict: false });
      for (const m of [market, other]) {
        await app.get(SeedRoles).execute(testCallContext(m, 'system', `db-r5-${randomUUID()}`), {});
      }
      admin = await adminContext();
    });
    afterAll(async () => {
      await sql.end();
      await app.close();
    });
    beforeEach(() => {
      logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    });
    afterEach(() => logs.forEach((spy) => spy.mockRestore()));
    const logged = () => JSON.stringify(logs.flatMap((spy) => spy.mock.calls as unknown[]));

    /** A seller created by an invitation (registered, pending), with its subject key. */
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

    async function decide(
      sellerId: Id<'Seller'>,
      make: (access: SellerAccess, decisionId: Id<'AccessDecision'>) => AccessDecision,
      m: MarketContext = market,
    ): Promise<Id<'AccessDecision'>> {
      const decisionId = newId<'AccessDecision'>();
      await inUnit(m, async () => {
        const access = (await sellers.findById(m, sellerId))!;
        const decision = make(access, decisionId);
        await sellers.save(m, access);
        await decisions.add(m, decision);
      });
      return decisionId;
    }
    const unwrap = <T>(result: { ok: boolean; value?: T }): T => {
      if (!result.ok) throw new Error('refused');
      return result.value as T;
    };
    const at = (seconds: number) => Temporal.Instant.from('2026-10-09T09:00:00Z').add({ seconds });

    /** Approved on `basisId`, suspended with the canary reason, then reinstated. */
    async function history(sellerId: Id<'Seller'>, basisId: Id, m: MarketContext = market) {
      const approved = await decide(
        sellerId,
        (access, decisionId) =>
          unwrap(access.approve({ decisionId, decidedBy: null, now: at(1), basisId })),
        m,
      );
      const suspended = await decide(
        sellerId,
        (access, decisionId) =>
          unwrap(access.suspend({ decisionId, decidedBy: DECIDER, now: at(2), reason: REASON })),
        m,
      );
      const reinstated = await decide(
        sellerId,
        (access, decisionId) =>
          unwrap(access.reinstate({ decisionId, decidedBy: null, now: at(3) })),
        m,
      );
      return { approved, suspended, reinstated };
    }

    it('answers the decisions newest first with the reason opened under the real key, then erased', async () => {
      const sellerId = await seller();
      const basisId = newId();
      const { approved, suspended, reinstated } = await history(sellerId, basisId);

      const result = await contract.accessDecisionsOf(admin, sellerId);

      expect(result.ok).toBe(true);
      const view = result.ok ? result.value : null;
      expect(view?.truncated).toBe(false);
      expect(
        view?.decisions.map((d) => [d.decisionId, d.kind, d.resultingState, d.basisId, d.reason]),
      ).toEqual([
        [reinstated, 'reinstated', 'approved', null, { status: 'none' }],
        [suspended, 'suspended', 'suspended', null, { status: 'present', text: REASON }],
        [approved, 'approved', 'approved', basisId, { status: 'none' }],
      ]);
      expect(view?.decisions[2]!.decidedBy).toEqual({ kind: 'system' });
      expect(view?.decisions[2]!.decidedAt.equals(at(1))).toBe(true);

      await inUnit(market, () => keys.destroyKey(market, sellerId));
      const erased = await contract.accessDecisionsOf(admin, sellerId);
      expect(erased.ok && erased.value.decisions.map((d) => d.reason.status)).toEqual([
        'none',
        'erased',
        'none',
      ]);
      expect(logged()).not.toContain('permit 7719');
    });

    it('answers unavailable for a ciphertext that does not authenticate, never a partial list (C2)', async () => {
      const sellerId = await seller();
      const neighbour = await seller();
      await history(sellerId, newId());
      await history(neighbour, newId());
      // A row of this seller carrying the neighbour's sealed reason (as a copy or a tamper would).
      await sql.query(
        `INSERT INTO identity.access_decisions (id, market_id, tenant_id, seller_id, decision,
       reason_ciphertext, basis_id, decided_by_account_id, decided_at)
       SELECT $1, market_id, tenant_id, $2, decision, reason_ciphertext, NULL, NULL,
              decided_at + interval '1 hour'
         FROM identity.access_decisions
        WHERE market_id = $3 AND seller_id = $4 AND decision = 'suspended'`,
        [newId(), sellerId, code, neighbour],
      );
      const { rows } = await sql.query<{ c: string }>(
        `SELECT reason_ciphertext AS c FROM identity.access_decisions
        WHERE market_id = $1 AND seller_id = $2 AND reason_ciphertext IS NOT NULL`,
        [code, sellerId],
      );

      await expect(contract.accessDecisionsOf(admin, sellerId)).resolves.toEqual({
        ok: false,
        error: { code: 'access-decisions.unavailable' },
      });
      expect(logged()).toContain('identity.access-decisions.integrity-failed');
      for (const row of rows) expect(logged()).not.toContain(row.c.slice(0, 24));
      expect(logged()).not.toContain('permit 7719');
    });

    it("answers another Market's seller and an unknown id the same: an empty list", async () => {
      const foreign = await seller(other);
      await history(foreign, newId(), other);
      const unknown = newId<'Seller'>();

      const a = await contract.accessDecisionsOf(admin, foreign);
      const b = await contract.accessDecisionsOf(admin, unknown);

      expect(a).toEqual({
        ok: true,
        value: { sellerId: foreign, decisions: [], truncated: false },
      });
      expect(JSON.stringify(a).replaceAll(foreign, 'X')).toBe(
        JSON.stringify(b).replaceAll(unknown, 'X'),
      );
    });

    it('finds decisions by pair only when Market, seller and basis match; nothing decrypted (C5)', async () => {
      const sellerId = await seller();
      const neighbour = await seller();
      const foreign = await seller(other);
      const basisId = newId();
      const mine = await history(sellerId, basisId);
      // The same basis id under another seller of this Market, and under another Market.
      await history(neighbour, basisId);
      await history(foreign, basisId, other);

      const result = await contract.accessDecisionsByBasis(system, [
        { sellerId, basisId },
        { sellerId, basisId },
        { sellerId: foreign, basisId },
      ]);

      expect(
        result.ok && result.value.map((r) => [r.sellerId, r.basisId, r.decisionId, r.kind]),
      ).toEqual([[sellerId, basisId, mine.approved, 'approved']]);
      expect(Object.keys(result.ok ? result.value[0]! : {}).sort()).toEqual([
        'basisId',
        'decidedAt',
        'decisionId',
        'kind',
        'sellerId',
      ]);
      // The same pair under the other Market's context answers that Market's decision only.
      const there = await contract.accessDecisionsByBasis(
        testCallContext(other, 'system', `db-r5-${randomUUID()}`),
        [{ sellerId, basisId }],
      );
      expect(there).toEqual({ ok: true, value: [] });
      await expect(
        contract.accessDecisionsByBasis(admin, [{ sellerId, basisId }]),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(logged()).not.toContain('permit 7719');
    });

    it('stands on the (market_id, basis_id) and (market_id, seller_id, decided_at) indexes', async () => {
      const { rows } = await sql.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'identity'
        AND tablename = 'access_decisions' ORDER BY indexname`,
      );

      expect(rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining([
          'access_decisions_market_id_basis_id_idx',
          'access_decisions_market_id_seller_id_decided_at_idx',
        ]),
      );
    });
  },
);
