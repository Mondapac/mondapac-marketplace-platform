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
  const turnOn = (context: CallContext) =>
    app.get(SetWalletStatus).execute(context, { status: 'active' });
  /** The switch and who moved it last; `off` and null while the Market has no row. */
  const switchOf = async () => {
    const { rows } = await sql.query<{ status: string; updated_by_account_id: string }>(
      `SELECT status, updated_by_account_id FROM wallet.market_settings WHERE market_id = $1`,
      [code],
    );
    return { status: rows[0]?.status ?? 'off', by: rows[0]?.updated_by_account_id ?? null };
  };
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
    expect((await auditsBy(accountId)).map((row) => [row.action, row.target_id])).toEqual([
      ['identity.admin-step-up.verified', accountId],
      ['wallet.market-status.changed', 'wallet-settings'],
    ]);
    expect((await auditsBy(accountId))[0]!.after).toEqual({
      sessionId: sessionIdOf(context),
      actionKey: ACTION,
    });
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
