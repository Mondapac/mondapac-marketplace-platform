import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  SECOND_FACTOR_SECRETS,
  type SecondFactorSecrets,
} from '../../src/modules/identity/application/ports/second-factor-secrets';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import {
  STEP_UP_REPOSITORY,
  type StepUpRepository,
} from '../../src/modules/identity/application/ports/step-up.repository';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { VerifyAdminStepUp } from '../../src/modules/identity/application/use-cases/verify-admin-step-up.use-case';
import { openSession } from '../../src/modules/identity/domain/session';
import { timeStepAt } from '../../src/modules/identity/domain/totp';
import { hotp } from '../../src/modules/identity/infrastructure/second-factor/totp';
import { SetWalletStatus } from '../../src/modules/wallet/application/use-cases/set-wallet-status.use-case';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../src/platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { walletSwitchOwnerTestDatabaseUrl, walletSwitchTestDatabaseUrl } from './test-database';

// The admin step-up on PostgreSQL (issue #491), for both Market fixtures, as the application role
// on a copy of the run database of this file alone (global-setup.ts: the wallet switch of a Market
// is one row). The real application: a Platform Administrator with a real sealed authenticator
// secret presents a code for `wallet.settings.change` (`VerifyAdminStepUp`), the proof is stored
// for that session and action, and only then does the real `SetWalletStatus` move the switch,
// with identity's and wallet's audit rows. Without a proof, with one of another session or
// action, or with an expired one, the switch stays where it was.

const CREATED = '2026-10-25T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ACTION = 'wallet.settings.change';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('the admin step-up in market %s (database)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let owner: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: walletSwitchTestDatabaseUrl() } }));
    sql = new Client({ connectionString: walletSwitchTestDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: walletSwitchOwnerTestDatabaseUrl() });
    await owner.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-admin-step-up-${randomUUID()}`), {});
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
    // The switch starts off in every case (its row is never deleted; no journal exists here).
    await owner.query(
      `UPDATE wallet.market_settings SET status = 'off', reason_code = NULL WHERE market_id = $1`,
      [code],
    );
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

  /** A Platform Administrator with an active factor whose secret the test knows. */
  async function administrator(
    factorState: 'active' | 'pending' = 'active',
  ): Promise<{ accountId: Id<'Account'>; secret: Uint8Array }> {
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
    const secrets = app.get<SecondFactorSecrets>(SECOND_FACTOR_SECRETS);
    const secret = secrets.newSecret();
    await inUnit(() =>
      app.get<SubjectKeyService>(SUBJECT_KEY_SERVICE).createKey(market, accountId as Id),
    );
    const sealed = await inUnit(() => secrets.seal(market, accountId, secret));
    const factorId = newId<'SecondFactor'>();
    await sql.query(
      `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id, state,
       secret_ciphertext, pending_secret_ciphertext, last_accepted_step, activated_at,
       created_at, version) VALUES ($1, $2, 'default', $3, $4, $5, NULL, NULL, $6, $7, 1)`,
      [
        factorId,
        code,
        accountId,
        factorState,
        sealed,
        factorState === 'active' ? CREATED : null,
        CREATED,
      ],
    );
    // An active factor holds its ten recovery codes.
    for (let position = 1; factorState === 'active' && position <= 10; position += 1) {
      await sql.query(
        `INSERT INTO identity.recovery_codes (market_id, tenant_id, second_factor_id, position,
         code_hash) VALUES ($1, 'default', $2, $3, $4)`,
        [code, factorId, position, randomBytes(32)],
      );
    }
    return { accountId, secret };
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
      `db-admin-step-up-${randomUUID()}`,
    );
  }

  const sessionIdOf = (context: CallContext): Id<'Session'> =>
    (context.actor as { sessionId: Id<'Session'> }).sessionId;
  const codeNow = (secret: Uint8Array) => hotp(secret, timeStepAt(Temporal.Now.instant()));
  /** What a fresh admin tab sees: 0 for no row or the seeded "never set" row, else the column. */
  const versionNow = async () => {
    const { rows } = await sql.query<{ version: number; updated_by_account_id: string }>(
      `SELECT version, updated_by_account_id FROM wallet.market_settings WHERE market_id = $1`,
      [code],
    );
    const row = rows[0];
    return row === undefined || row.updated_by_account_id === '00000000-0000-0000-0000-000000000000'
      ? 0
      : Number(row.version);
  };
  const turnOn = async (context: CallContext) =>
    app
      .get(SetWalletStatus)
      .execute(context, { status: 'active', expectedVersion: await versionNow() });
  /** The switch and who moved it last; `off` and null while the Market has no row. */
  const switchOf = async () => {
    const { rows } = await sql.query<{ status: string; updated_by_account_id: string }>(
      `SELECT status, updated_by_account_id FROM wallet.market_settings WHERE market_id = $1`,
      [code],
    );
    return { status: rows[0]?.status ?? 'off', by: rows[0]?.updated_by_account_id ?? null };
  };
  const proofRows = async (context: CallContext) =>
    Number(
      (
        await sql.query<{ n: string }>(
          `SELECT count(*) AS n FROM identity.step_up_proofs WHERE market_id = $1
           AND session_id = $2`,
          [code, sessionIdOf(context)],
        )
      ).rows[0]!.n,
    );
  const auditsBy = async (actorId: string) =>
    (
      await sql.query<{ action: string; target_id: string; after: Record<string, unknown> }>(
        `SELECT action, target_id, after FROM platform.audit_log
         WHERE market_id = $1 AND actor_id = $2 ORDER BY occurred_at, action`,
        [code, actorId],
      )
    ).rows;

  it('refuses the switch without a proof, then moves it after a verified code, audited', async () => {
    const { accountId, secret } = await administrator();
    const context = await sessionOf(accountId);

    expect(await turnOn(context)).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: ACTION },
    });
    expect((await switchOf()).status).toBe('off');

    expect(
      await app.get(VerifyAdminStepUp).execute(context, { actionKey: ACTION, code: '000000' }),
    ).toMatchObject({ ok: false, error: { code: 'second-factor.invalid' } });
    expect(await turnOn(context)).toMatchObject({ ok: false });

    expect(
      await app
        .get(VerifyAdminStepUp)
        .execute(context, { actionKey: ACTION, code: codeNow(secret) }),
    ).toEqual({ ok: true, value: { code: 'step-up-verified', actionKey: ACTION } });
    const { rows: proofs } = await sql.query<{ session_id: string; action_key: string }>(
      `SELECT session_id, action_key FROM identity.step_up_proofs WHERE market_id = $1
       AND session_id = $2`,
      [code, sessionIdOf(context)],
    );
    expect(proofs).toEqual([{ session_id: sessionIdOf(context), action_key: ACTION }]);

    expect(await turnOn(context)).toMatchObject({ ok: true, value: { status: 'active' } });
    expect(await switchOf()).toEqual({ status: 'active', by: accountId });
    const audits = await auditsBy(accountId);
    expect(audits.map((row) => [row.action, row.target_id])).toEqual([
      ['identity.admin-step-up.refused', accountId],
      ['identity.admin-step-up.verified', accountId],
      ['wallet.market-status.changed', 'wallet-settings'],
    ]);
    expect(audits[0]!.after).toEqual({
      sessionId: sessionIdOf(context),
      actionKey: ACTION,
      cause: 'invalid',
    });
    expect(audits[1]!.after).toEqual({ sessionId: sessionIdOf(context), actionKey: ACTION });
    // The change names the proof it spent (Hassan L3).
    const { rows: proofTimes } = await sql.query<{ verified_at: Date }>(
      `SELECT occurred_at AS verified_at FROM platform.audit_log WHERE market_id = $1
       AND actor_id = $2 AND action = 'identity.admin-step-up.verified'`,
      [code, accountId],
    );
    expect(audits[2]!.after).toMatchObject({
      status: 'active',
      stepUpSessionId: sessionIdOf(context),
    });
    // The proof's instant is the verify's: the same unit wrote the proof and that audit row.
    expect(
      Temporal.Instant.from(audits[2]!.after['stepUpVerifiedAt'] as string).epochMilliseconds,
    ).toBeLessThanOrEqual(proofTimes[0]!.verified_at.getTime() + 1000);
  });

  it('spends the proof with the change: the next change needs a new code (Hassan L1)', async () => {
    const { accountId } = await administrator();
    const context = await sessionOf(accountId);
    const proofs = app.get<StepUpRepository>(STEP_UP_REPOSITORY);
    await inUnit(() =>
      proofs.recordProof(market, sessionIdOf(context), ACTION, Temporal.Now.instant()),
    );

    expect(await turnOn(context)).toMatchObject({ ok: true, value: { status: 'active' } });
    expect(await proofRows(context)).toBe(0);
    expect(
      await app.get(SetWalletStatus).execute(context, {
        status: 'paused',
        reasonCode: 'maintenance',
        expectedVersion: await versionNow(),
      }),
    ).toEqual({ ok: false, error: { code: 'second-factor.required', actionKey: ACTION } });
    expect((await switchOf()).status).toBe('active');
  });

  it('a stale save answers wallet.settings-conflict and leaves the proof unspent', async () => {
    const { accountId } = await administrator();
    const context = await sessionOf(accountId);
    const proofs = app.get<StepUpRepository>(STEP_UP_REPOSITORY);
    await inUnit(() =>
      proofs.recordProof(market, sessionIdOf(context), ACTION, Temporal.Now.instant()),
    );
    const stale = await versionNow();

    // Another admin tab moves the switch first (their own proof is not modelled: the row is set
    // directly, as the save of the other tab would have left it).
    await sql.query(
      `INSERT INTO wallet.market_settings (market_id, tenant_id, status, updated_at, updated_by_account_id, version)
       VALUES ($1, 'default', 'active', now(), $2, $3)
       ON CONFLICT (market_id) DO UPDATE SET status = 'active', updated_by_account_id = $2, version = $3`,
      [code, accountId, stale + 1],
    );

    expect(
      await app
        .get(SetWalletStatus)
        .execute(context, { status: 'paused', reasonCode: 'maintenance', expectedVersion: stale }),
    ).toEqual({ ok: false, error: { code: 'wallet.settings-conflict' } });
    expect(await proofRows(context)).toBe(1);
    expect((await switchOf()).status).toBe('active');

    // The same admin retries with the version it now sees: the kept proof is spent once.
    expect(
      await app.get(SetWalletStatus).execute(context, {
        status: 'paused',
        reasonCode: 'maintenance',
        expectedVersion: stale + 1,
      }),
    ).toMatchObject({ ok: true, value: { status: 'paused', version: stale + 2 } });
    expect(await proofRows(context)).toBe(0);
  });

  it('lets exactly one of two concurrent changes spend one proof (Hassan L1, L2)', async () => {
    const { accountId } = await administrator();
    const context = await sessionOf(accountId);
    const proofs = app.get<StepUpRepository>(STEP_UP_REPOSITORY);
    await inUnit(() =>
      proofs.recordProof(market, sessionIdOf(context), ACTION, Temporal.Now.instant()),
    );

    const expectedVersion = await versionNow();
    const results = await Promise.all([
      app.get(SetWalletStatus).execute(context, { status: 'active', expectedVersion }),
      app
        .get(SetWalletStatus)
        .execute(context, { status: 'paused', reasonCode: 'maintenance', expectedVersion }),
    ]);

    // Both saw the same version: the loser queues on the row lock, finds the version moved and
    // answers a conflict before it reaches the proof (the proof was spent once, by the winner).
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'wallet.settings-conflict' } },
    ]);
    expect(await proofRows(context)).toBe(0);
    const changes = (await auditsBy(accountId)).filter(
      (row) => row.action === 'wallet.market-status.changed',
    );
    expect(changes).toHaveLength(1);
  });

  it('keeps the proof when the change is refused, and ends it when the factor is enrolled again', async () => {
    const { accountId } = await administrator();
    const context = await sessionOf(accountId);
    const proofs = app.get<StepUpRepository>(STEP_UP_REPOSITORY);
    await inUnit(() =>
      proofs.recordProof(
        market,
        sessionIdOf(context),
        ACTION,
        Temporal.Now.instant().subtract({ seconds: 2 }),
      ),
    );
    // A refusal before the spend (bad body) leaves the proof where it was.
    expect(
      (
        await app
          .get(SetWalletStatus)
          .execute(context, { status: 'paused', expectedVersion: await versionNow() })
      ).ok,
    ).toBe(false);
    expect(await proofRows(context)).toBe(1);

    // A re-enrolment activates the factor after the proof was made.
    await sql.query(
      `UPDATE identity.second_factors SET activated_at = $3, version = version + 1
       WHERE market_id = $1 AND account_id = $2`,
      [code, accountId, Temporal.Now.instant().toString()],
    );
    expect(await turnOn(context)).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: ACTION },
    });
    expect((await switchOf()).status).toBe('off');
  });

  it('does not accept a proof of another session, of another action, or an expired one', async () => {
    const { accountId } = await administrator();
    const context = await sessionOf(accountId);
    const other = await sessionOf(accountId);
    const proofs = app.get<StepUpRepository>(STEP_UP_REPOSITORY);
    const now = Temporal.Now.instant();

    await inUnit(() => proofs.recordProof(market, sessionIdOf(other), ACTION, now));
    expect(await turnOn(context)).toMatchObject({
      ok: false,
      error: { code: 'second-factor.required' },
    });
    await inUnit(() =>
      proofs.recordProof(market, sessionIdOf(context), 'payments.payout-account.change', now),
    );
    expect(await turnOn(context)).toMatchObject({
      ok: false,
      error: { code: 'second-factor.required' },
    });
    await inUnit(() =>
      proofs.recordProof(market, sessionIdOf(context), ACTION, now.subtract({ minutes: 6 })),
    );
    expect(await turnOn(context)).toMatchObject({
      ok: false,
      error: { code: 'second-factor.required' },
    });
    expect((await switchOf()).status).toBe('off');

    // The other session's own proof lets that session through.
    expect(await turnOn(other)).toMatchObject({ ok: true, value: { status: 'active' } });
  });

  it('asks an admin without an active factor to set one up', async () => {
    const { accountId } = await administrator('pending');
    const context = await sessionOf(accountId);

    expect(await turnOn(context)).toEqual({
      ok: false,
      error: { code: 'second-factor.enrolment-required', actionKey: ACTION },
    });
    expect((await switchOf()).status).toBe('off');
  });
});
