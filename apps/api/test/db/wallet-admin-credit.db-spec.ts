import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import {
  STEP_UP_REPOSITORY,
  type StepUpRepository,
} from '../../src/modules/identity/application/ports/step-up.repository';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { openSession } from '../../src/modules/identity/domain/session';
import { ApproveAdminCredit } from '../../src/modules/wallet/application/use-cases/approve-admin-credit.use-case';
import { ExpireAdminCreditRequests } from '../../src/modules/wallet/application/use-cases/expire-admin-credit-requests.use-case';
import { IssueAdminCredit } from '../../src/modules/wallet/application/use-cases/issue-admin-credit.use-case';
import { RejectAdminCredit } from '../../src/modules/wallet/application/use-cases/reject-admin-credit.use-case';
import { localDayOf } from '../../src/modules/wallet/domain/admin-credit';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { walletCreditOwnerTestDatabaseUrl, walletCreditTestDatabaseUrl } from './test-database';

// Admin credit issuance with maker-checker on PostgreSQL (customer wallet package 2a), for both
// Market fixtures, as the application role on a copy of the run database of this file alone
// (global-setup.ts: the file moves each Market's wallet switch). The real application: Platform
// Administrators with stored two-step proofs of their own sessions; the real use cases, gate,
// identity's proof consumer, ledger and audit writer. It proves the single use of each proof,
// maker-checker in the use case and in a CHECK, the daily cap under two parallel issues, the
// tables' guards, the switch fence and the expiry sweep.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const CREATED = '2026-10-25T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ISSUE = 'wallet.credit.issue';
const APPROVE = 'wallet.credit.approve';
const CHECK = '23514';
const RESTRICT = '23001';
const NO_PRIVILEGE = '42501';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('admin credit in market %s (database)', (code) => {
  const market = marketOf(code);
  const config = markets.get(market.marketId);
  const currency = config.defaultCurrency;
  const issueCap = BigInt(config.wallet!.adminIssueCapMinor);
  const dailyCap = BigInt(config.wallet!.adminDailyCapMinor);
  const amount = (minor: bigint) => money(minor, currency);
  let app: NestExpressApplication;
  let sql: Client;
  let owner: Client;
  let logs: jest.SpyInstance[];

  const setSwitch = (status: 'active' | 'paused') =>
    owner.query(
      `INSERT INTO wallet.market_settings (market_id, tenant_id, status, reason_code, updated_at, updated_by_account_id)
       VALUES ($1, 'default', $2, $3, now(), $4)
       ON CONFLICT (market_id) DO UPDATE SET status = EXCLUDED.status, reason_code = EXCLUDED.reason_code`,
      [code, status, status === 'paused' ? 'maintenance' : null, newId()],
    );

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: walletCreditTestDatabaseUrl() } }));
    sql = new Client({ connectionString: walletCreditTestDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: walletCreditOwnerTestDatabaseUrl() });
    await owner.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-admin-credit-${randomUUID()}`), {});
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await app.close();
  });
  beforeEach(async () => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    await setSwitch('active');
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const units = () => app.get<UnitOfWork>(UNIT_OF_WORK);
  const inUnit = <T>(work: () => Promise<T>): Promise<T> =>
    units()
      .run(market, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unit refused');
        return result.value;
      });
  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );

  /** A Platform Administrator with an active factor (no secret needed: proofs are stored). */
  async function administrator(): Promise<Id<'Account'>> {
    const accountId = newId<'Account'>();
    const email = `Admin.${accountId}@Admin.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, 'Admin', 'active', $5, $5, 1, $5)`,
      [accountId, code, email, email.toLowerCase(), CREATED],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, accountId, PASSWORD_HASH, CREATED],
    );
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform'
       AND seed_code = 'platform-administrator'`,
      [code],
    );
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), code, accountId, rows[0]!.id, CREATED],
    );
    const factorId = newId<'SecondFactor'>();
    await sql.query(
      `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id, state,
       secret_ciphertext, pending_secret_ciphertext, last_accepted_step, activated_at,
       created_at, version) VALUES ($1, $2, 'default', $3, 'active', $4, NULL, NULL, $5, $5, 1)`,
      [factorId, code, accountId, randomBytes(48).toString('base64'), CREATED],
    );
    for (let position = 1; position <= 10; position += 1) {
      await sql.query(
        `INSERT INTO identity.recovery_codes (market_id, tenant_id, second_factor_id, position,
         code_hash) VALUES ($1, 'default', $2, $3, $4)`,
        [code, factorId, position, randomBytes(32)],
      );
    }
    return accountId;
  }

  /** A signed-in admin session of the account, as the call context the guards would mint. */
  async function sessionOf(accountId: Id<'Account'>): Promise<CallContext> {
    const sessionId = newId<'Session'>();
    await inUnit(() =>
      app.get<SessionRepository>(SESSION_REPOSITORY).add(
        market,
        openSession({
          id: sessionId,
          marketId: market.marketId,
          accountId,
          population: 'admin',
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: Temporal.Now.instant(),
        }),
        new Uint8Array(randomBytes(32)),
      ),
    );
    return testCallContext(
      market,
      testAuthenticatedActor(market, { population: 'admin', accountId, sessionId, sellerId: null }),
      `db-admin-credit-${randomUUID()}`,
    );
  }

  const sessionIdOf = (context: CallContext): Id<'Session'> =>
    (context.actor as { sessionId: Id<'Session'> }).sessionId;
  const prove = (context: CallContext, action: string) =>
    inUnit(() =>
      app
        .get<StepUpRepository>(STEP_UP_REPOSITORY)
        .recordProof(market, sessionIdOf(context), action, Temporal.Now.instant()),
    );
  const proofs = async (context: CallContext) =>
    Number(
      (
        await sql.query<{ n: string }>(
          `SELECT count(*) AS n FROM identity.step_up_proofs WHERE market_id = $1 AND session_id = $2`,
          [code, sessionIdOf(context)],
        )
      ).rows[0]!.n,
    );
  const issue = (
    context: CallContext,
    minor: bigint,
    customerAccountId: Id<'Account'> = newId(),
    idempotencyKey = `db-issue-${randomUUID()}`,
  ) =>
    app.get(IssueAdminCredit).execute(context, {
      customerAccountId,
      amount: amount(minor),
      reasonCode: 'goodwill',
      note: 'late parcel',
      idempotencyKey,
    });
  const requestRow = async (id: string) =>
    (
      await sql.query<Record<string, unknown>>(
        `SELECT status, journal_id, decided_by_account_id, requested_by_account_id, note
         FROM wallet.admin_credit_requests WHERE market_id = $1 AND id = $2`,
        [code, id],
      )
    ).rows[0];
  const auditsOf = async (targetId: string) =>
    (
      await sql.query<{ action: string; actor_id: string | null; after: Record<string, unknown> }>(
        `SELECT action, actor_id, after FROM platform.audit_log WHERE market_id = $1
         AND target_id = $2 ORDER BY occurred_at, action`,
        [code, targetId],
      )
    ).rows;
  /** A pending request of `admin`, made at `requestedAt`, written as the application role. */
  const pendingRow = async (
    admin: Id<'Account'>,
    minor: bigint,
    requestedAt: Temporal.Instant = Temporal.Now.instant(),
    days = 7,
  ) => {
    const id = newId<'WalletCreditRequest'>();
    await sql.query(
      `INSERT INTO wallet.admin_credit_requests (id, market_id, tenant_id, customer_account_id,
       amount_minor, currency, reason_code, note, status, approval_reason, requested_by_account_id,
       requested_at, local_day, expires_at, idempotency_key, fingerprint)
       VALUES ($1, $2, 'default', $3, $4, $5, 'goodwill', NULL, 'pending', 'daily-cap', $6, $7, $8,
       $9, $10, 'fp')`,
      [
        id,
        code,
        newId(),
        minor,
        currency,
        admin,
        requestedAt.toString(),
        localDayOf(requestedAt, config.timezone),
        requestedAt.add({ hours: days * 24 }).toString(),
        `db-row-${randomUUID()}`,
      ],
    );
    return id;
  };

  it('grants within the caps with a fresh proof, spends it once, and audits the issue', async () => {
    const admin = await administrator();
    const context = await sessionOf(admin);
    expect(await issue(context, 1n)).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: ISSUE },
    });
    await prove(context, ISSUE);
    const customer = newId<'Account'>();
    const granted = await issue(context, issueCap, customer);
    expect(granted).toMatchObject({ ok: true, value: { status: 'granted', amount: issueCap } });
    if (!granted.ok) return;
    expect(await proofs(context)).toBe(0);
    // The proof served one issue only.
    expect(await issue(context, 1n)).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: ISSUE },
    });
    expect(await requestRow(granted.value.id)).toMatchObject({
      status: 'granted',
      journal_id: granted.value.journalId,
      note: 'late parcel',
    });
    const { rows: journals } = await sql.query<{ kind: string; actor_id: string }>(
      `SELECT kind, actor_id FROM wallet.journals WHERE market_id = $1 AND id = $2`,
      [code, granted.value.journalId],
    );
    expect(journals).toEqual([{ kind: 'grant-promo', actor_id: admin }]);
    const audits = await auditsOf(granted.value.id);
    expect(audits.map((a) => [a.action, a.actor_id])).toEqual([
      ['wallet.admin-credit.issued', admin],
    ]);
    expect(audits[0]!.after).toMatchObject({
      status: 'granted',
      amount: { amount: issueCap.toString(), currency },
      stepUpSessionId: sessionIdOf(context),
    });
    expect(JSON.stringify(audits)).not.toContain('late parcel');
  });

  it('lets only a second admin decide, each with a proof of wallet.credit.approve spent once', async () => {
    const maker = await administrator();
    const checker = await administrator();
    const makerCtx = await sessionOf(maker);
    const checkerCtx = await sessionOf(checker);
    await prove(makerCtx, ISSUE);
    const asked = await issue(makerCtx, issueCap + 1n);
    expect(asked).toMatchObject({
      ok: true,
      value: { status: 'pending', approvalReason: 'issue-cap' },
    });
    if (!asked.ok) return;
    expect(
      Number(
        (
          await sql.query<{ n: string }>(
            `SELECT count(*) AS n FROM wallet.journals WHERE market_id = $1 AND idempotency_key = $2`,
            [code, `wallet:admin-credit:${asked.value.id}`],
          )
        ).rows[0]!.n,
      ),
    ).toBe(0);

    await prove(makerCtx, APPROVE);
    expect(
      await app.get(ApproveAdminCredit).execute(makerCtx, { requestId: asked.value.id }),
    ).toEqual({ ok: false, error: { code: 'wallet.approver-is-requester' } });
    expect(await proofs(makerCtx)).toBe(1);

    expect(
      await app.get(ApproveAdminCredit).execute(checkerCtx, { requestId: asked.value.id }),
    ).toEqual({ ok: false, error: { code: 'second-factor.required', actionKey: APPROVE } });
    await prove(checkerCtx, APPROVE);
    const approved = await app
      .get(ApproveAdminCredit)
      .execute(checkerCtx, { requestId: asked.value.id });
    expect(approved).toMatchObject({ ok: true, value: { status: 'approved', decidedBy: checker } });
    expect(await proofs(checkerCtx)).toBe(0);
    expect(await requestRow(asked.value.id)).toMatchObject({
      status: 'approved',
      decided_by_account_id: checker,
    });
    expect((await auditsOf(asked.value.id)).map((a) => [a.action, a.actor_id])).toEqual([
      ['wallet.admin-credit.requested', maker],
      ['wallet.admin-credit.approved', checker],
    ]);

    // Reject spends the approve proof too, once.
    await prove(makerCtx, ISSUE);
    const second = await issue(makerCtx, issueCap + 1n);
    if (!second.ok) throw new Error(second.error.code);
    await prove(checkerCtx, APPROVE);
    expect(
      await app
        .get(RejectAdminCredit)
        .execute(checkerCtx, { requestId: second.value.id, reasonCode: 'duplicate' }),
    ).toMatchObject({ ok: true, value: { status: 'rejected' } });
    expect(await proofs(checkerCtx)).toBe(0);
    expect(
      await app
        .get(RejectAdminCredit)
        .execute(checkerCtx, { requestId: second.value.id, reasonCode: 'duplicate' }),
    ).toEqual({ ok: false, error: { code: 'wallet.credit-request-decided' } });
  });

  it('keeps the daily cap under two parallel issues straddling it: one granted, one pending', async () => {
    for (let round = 0; round < 3; round += 1) {
      const admin = await administrator();
      // The day already counts all but one per-issue cap of room.
      await pendingRow(admin, dailyCap - issueCap);
      const first = await sessionOf(admin);
      const second = await sessionOf(admin);
      await prove(first, ISSUE);
      await prove(second, ISSUE);
      const results = await Promise.all([issue(first, issueCap), issue(second, issueCap)]);
      const statuses = results.map((r) => (r.ok ? r.value.status : r.error.code)).sort();
      expect(statuses).toEqual(['granted', 'pending']);
      const pending = results.find((r) => r.ok && r.value.status === 'pending');
      expect(pending).toMatchObject({ value: { approvalReason: 'daily-cap' } });
      const { rows } = await sql.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_minor), 0) AS total FROM wallet.admin_credit_requests
         WHERE market_id = $1 AND requested_by_account_id = $2 AND status = 'granted'`,
        [code, admin],
      );
      expect(BigInt(rows[0]!.total)).toBe(issueCap);
    }
  });

  it('replays one key, refuses it for another request, and lets one of two admins have it', async () => {
    const a = await administrator();
    const b = await administrator();
    const aCtx = await sessionOf(a);
    const bCtx = await sessionOf(b);
    await prove(aCtx, ISSUE);
    const customer = newId<'Account'>();
    const key = `db-same-${randomUUID()}`;
    const first = await issue(aCtx, 10n, customer, key);
    expect(await issue(aCtx, 10n, customer, key)).toEqual(first);
    expect(await issue(aCtx, 11n, customer, key)).toEqual({
      ok: false,
      error: { code: 'idempotency.key-reused' },
    });
    await prove(aCtx, ISSUE);
    await prove(bCtx, ISSUE);
    const shared = `db-shared-${randomUUID()}`;
    const raced = await Promise.all([
      issue(aCtx, 10n, customer, shared),
      issue(bCtx, 10n, customer, shared),
    ]);
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect(raced.filter((r) => !r.ok)).toEqual([
      { ok: false, error: { code: 'idempotency.key-reused' } },
    ]);
  });

  it('refuses issues while the wallet is paused, in the use case and at the table', async () => {
    const admin = await administrator();
    const context = await sessionOf(admin);
    await prove(context, ISSUE);
    await setSwitch('paused');
    expect(await issue(context, 1n)).toEqual({ ok: false, error: { code: 'wallet.paused' } });
    expect(await proofs(context)).toBe(1);
    expect(await code_(pendingRow(admin, 1n))).toBe(RESTRICT);
  });

  it('expires undecided requests in the sweep, audited, and never twice', async () => {
    const admin = await administrator();
    const old = Temporal.Now.instant().subtract({ hours: 24 * 10 });
    const id = await pendingRow(admin, 7n, old);
    const system = testCallContext(market, 'system', `db-admin-credit-${randomUUID()}`);
    const swept = await app.get(ExpireAdminCreditRequests).execute(system, {});
    expect(swept).toMatchObject({ ok: true, value: { failed: [] } });
    expect(swept.ok && swept.value.expired).toBeGreaterThanOrEqual(1);
    expect(await requestRow(id)).toMatchObject({ status: 'expired', decided_by_account_id: null });
    expect((await auditsOf(id)).map((a) => [a.action, a.actor_id])).toEqual([
      ['wallet.admin-credit.expired', null],
    ]);
    await app.get(ExpireAdminCreditRequests).execute(system, {});
    expect(await auditsOf(id)).toHaveLength(1);
  });

  describe('the tables', () => {
    it('refuses a decision by the requester, a second decision and any other change', async () => {
      const admin = await administrator();
      const other = newId<'Account'>();
      const id = await pendingRow(admin, 5n);
      const decide = (by: string, status = 'rejected') =>
        sql.query(
          `UPDATE wallet.admin_credit_requests SET status = $3, decided_by_account_id = $4,
           decided_at = now(), decision_reason_code = 'duplicate' WHERE market_id = $1 AND id = $2`,
          [code, id, status, by],
        );
      expect(await code_(decide(admin))).toBe(CHECK);
      expect(await code_(decide(other))).toBe('allowed');
      expect(await code_(decide(newId()))).toBe(RESTRICT);
      expect(
        await code_(
          sql.query(`UPDATE wallet.admin_credit_requests SET amount_minor = 1 WHERE id = $1`, [id]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await code_(
          owner.query(`UPDATE wallet.admin_credit_requests SET note = 'x' WHERE id = $1`, [id]),
        ),
      ).toBe(RESTRICT);
    });

    it('refuses a request born decided, granted without its own grant journal, or deleted', async () => {
      const admin = await administrator();
      const insert = (status: string, journalId: string | null, expires: boolean) =>
        sql.query(
          `INSERT INTO wallet.admin_credit_requests (id, market_id, tenant_id, customer_account_id,
           amount_minor, currency, reason_code, status, approval_reason, requested_by_account_id,
           requested_at, local_day, expires_at, idempotency_key, fingerprint, journal_id)
           VALUES ($1, $2, 'default', $3, 5, $4, 'goodwill', $5, $6, $7, now(), current_date,
           $8, $9, 'fp', $10)`,
          [
            newId(),
            code,
            newId(),
            currency,
            status,
            status === 'granted' ? null : 'issue-cap',
            admin,
            expires ? Temporal.Now.instant().add({ hours: 1 }).toString() : null,
            `db-bad-${randomUUID()}`,
            journalId,
          ],
        );
      // A granted request names a journal: the grant of this very request, written in this
      // transaction. A made-up one, or another existing grant, fails the guard.
      expect(await code_(insert('granted', null, false))).toBe(CHECK);
      expect(await code_(insert('granted', newId(), false))).toBe(RESTRICT);
      const { rows } = await sql.query<{ id: string }>(
        `SELECT id FROM wallet.journals WHERE market_id = $1 AND kind = 'grant-promo' LIMIT 1`,
        [code],
      );
      expect(await code_(insert('granted', rows[0]!.id, false))).toBe(RESTRICT);
      expect(await code_(insert('approved', rows[0]!.id, true))).not.toBe('allowed');
      const id = await pendingRow(admin, 5n);
      expect(
        await code_(sql.query(`DELETE FROM wallet.admin_credit_requests WHERE id = $1`, [id])),
      ).toBe(NO_PRIVILEGE);
      expect(
        await code_(owner.query(`TRUNCATE wallet.admin_credit_requests, wallet.admin_credit_days`)),
      ).toBe(RESTRICT);
      expect(await code_(sql.query(`DELETE FROM wallet.admin_credit_days`))).toBe(NO_PRIVILEGE);
    });
  });
});
