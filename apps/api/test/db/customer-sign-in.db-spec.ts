import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client, DatabaseError } from 'pg';
import { SessionAuthenticator } from '../../src/modules/identity/application/access/session-authenticator';
import type {
  PasswordHasher,
  PasswordHasherBusy,
  PasswordVerification,
} from '../../src/modules/identity/application/ports/password-hasher';
import { PurgeExpired } from '../../src/modules/identity/application/use-cases/purge-expired.use-case';
import { RegisterCustomer } from '../../src/modules/identity/application/use-cases/register-customer.use-case';
import { SignInCustomer } from '../../src/modules/identity/application/use-cases/sign-in-customer.use-case';
import { SignOut } from '../../src/modules/identity/application/use-cases/sign-out.use-case';
import { IDENTITY_EVENTS } from '../../src/modules/identity/domain/events';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { CheckedInCommonPasswords } from '../../src/modules/identity/infrastructure/passwords/checked-in-common-passwords';
import { PrismaAccountRepository } from '../../src/modules/identity/infrastructure/prisma-account.repository';
import {
  HmacThrottleKeys,
  localThrottleSecret,
} from '../../src/modules/identity/infrastructure/sessions/hmac-throttle-keys';
import { PrismaSessionRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-session.repository';
import { PrismaSignInRecordRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-sign-in-record.repository';
import { PrismaOneTimeLinkRepository } from '../../src/modules/identity/infrastructure/links/prisma-one-time-link.repository';
import { PrismaThrottleRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-throttle.repository';
import { RandomSessionTokens } from '../../src/modules/identity/infrastructure/sessions/random-session-tokens';
import type { AccessDecision, AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Customer sign-in, sessions and throttling end to end on PostgreSQL (identity design 6.2, 6.3,
// 6.8, 10.2; data design 3.4 to 3.6, 9; slice 2), as the application role, for both Market
// fixtures: the real repositories, unit of work, keys and tokens. The hasher is a counting
// stand-in (the argon2id adapter is tested on its own; here the number of verifications is what
// HF1 is about). Only the clock is fixed.

const PASSWORD = 'correct horse battery staple';

/** Verifies `fake:<password>` hashes and counts every verification (HF1: guesses that hash). */
class CountingHasher implements PasswordHasher {
  verified = 0;
  hash(plain: string): Promise<Result<string, PasswordHasherBusy>> {
    return Promise.resolve(ok(`$argon2id$v=19$m=65536,t=3,p=1$fake$${plain}`));
  }
  async verify(
    plain: string,
    stored: string | null,
  ): Promise<Result<PasswordVerification, PasswordHasherBusy>> {
    this.verified += 1;
    // A little real time, so concurrent attempts overlap as they would around argon2.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return ok({
      matches: stored !== null && stored === `$argon2id$v=19$m=65536,t=3,p=1$fake$${plain}`,
      needsRehash: false,
    });
  }
}

const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe('customer sign-in (database integration)', () => {
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const policy = new MarketConfigIdentityPolicy(markets);
  const tokens = new RandomSessionTokens();
  const keys = new HmacThrottleKeys(
    localThrottleSecret({ nodeEnv: 'test', nodeEnvExplicit: true }),
  );
  let db: Persistence;
  let sql: Client;
  let hasher: CountingHasher;
  let register: RegisterCustomer;
  let signIn: SignInCustomer;
  let signOut: SignOut;
  let purge: PurgeExpired;
  let authenticator: SessionAuthenticator;
  let warnings: jest.SpyInstance;

  beforeAll(async () => {
    db = createPersistence();
    const catalogue = new EventCatalogue();
    catalogue.register('identity', IDENTITY_EVENTS);
    catalogue.seal();
    const accounts = new PrismaAccountRepository(
      db.service,
      new NodeSubjectKeyService(
        new PrismaSubjectKeyStore(db.service, db.unitOfWork),
        new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
        clock,
      ),
    );
    const sessions = new PrismaSessionRepository(db.service);
    const throttles = new PrismaThrottleRepository(db.service);
    const records = new PrismaSignInRecordRepository(db.service);
    const links = new PrismaOneTimeLinkRepository(db.service);
    hasher = new CountingHasher();
    const gate = createUseCaseGate(markets, allow);
    register = new RegisterCustomer(gate, {
      unitOfWork: db.unitOfWork,
      accounts,
      links,
      throttles,
      keys,
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('identity'),
      hasher,
      commonPasswords: new CheckedInCommonPasswords(),
      policy,
      clock,
      ids,
    });
    signIn = new SignInCustomer(gate, {
      unitOfWork: db.unitOfWork,
      accounts,
      sessions,
      throttles,
      records,
      hasher,
      tokens,
      keys,
      policy,
      clock,
      ids,
    });
    signOut = new SignOut(gate, { unitOfWork: db.unitOfWork, sessions, clock });
    purge = new PurgeExpired(gate, {
      unitOfWork: db.unitOfWork,
      sessions,
      throttles,
      records,
      links,
      policy,
      clock,
    });
    authenticator = new SessionAuthenticator({
      unitOfWork: db.unitOfWork,
      sessions,
      tokens,
      clock,
    });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    hasher.verified = 0;
  });
  afterEach(() => warnings.mockRestore());

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const context = () => testCallContext(market, 'anonymous', `db-sign-in-${randomUUID()}`);
    /** A fresh origin per test, so counters of other tests never interfere. */
    const freshClient = () => {
      const n = Math.floor(Math.random() * 250) + 1;
      const m = Math.floor(Math.random() * 250) + 1;
      return { origin: `10.${n}.${m}.9`, address: `10.${n}.${m}.9` };
    };

    async function verifiedAccount(): Promise<{ email: string; accountId: string }> {
      const email = `Sign.In+${randomUUID()}@Example.com`;
      await register.execute(context(), { origin: '192.0.2.1', email, password: PASSWORD });
      const { rows } = await sql.query<{ id: string }>(
        `UPDATE identity.accounts SET email_verified_at = signed_up_at
          WHERE market_id = $1 AND email_normalized = $2 RETURNING id`,
        [code, email.toLowerCase()],
      );
      return { email, accountId: rows[0]!.id };
    }

    it('opens a session: only the token hash is stored, and the attempt is recorded with its address', async () => {
      const { email, accountId } = await verifiedAccount();
      const client = freshClient();

      const result = await signIn.execute(context(), { email, password: PASSWORD, client });

      expect(result.ok).toBe(true);
      const token = result.ok ? result.value.token : '';
      const sessions = await sql.query<{
        id: string;
        token_hash: Buffer;
        transport: string;
        population: string;
        tenant_id: string;
      }>('SELECT * FROM identity.sessions WHERE market_id = $1 AND account_id = $2', [
        code,
        accountId,
      ]);
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]).toMatchObject({
        transport: 'cookie',
        population: 'customer',
        tenant_id: market.tenantId,
      });
      expect(Buffer.from(tokens.hashOf(token)!).equals(sessions.rows[0]!.token_hash)).toBe(true);
      const records = await sql.query<{
        outcome: string;
        origin: string;
        session_id: string;
        account_id: string;
      }>(
        `SELECT outcome, host(origin) AS origin, session_id, account_id FROM identity.sign_in_records
          WHERE market_id = $1 AND account_id = $2`,
        [code, accountId],
      );
      expect(records.rows).toEqual([
        {
          outcome: 'signed-in',
          origin: client.address,
          session_id: sessions.rows[0]!.id,
          account_id: accountId,
        },
      ]);

      // The Authenticator accepts the token in this Market only, and sign-out ends it.
      const actor = await authenticator.authenticate(market, { token, transport: 'cookie' });
      expect(actor).toMatchObject({
        ok: true,
        value: { accountId, sessionId: sessions.rows[0]!.id },
      });
      await expect(
        authenticator.authenticate(marketOf(otherMarketOf(code)), { token, transport: 'cookie' }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
      await expect(
        signOut.execute(testCallContext(market, actor.ok ? actor.value : 'anonymous'), {}),
      ).resolves.toEqual({ ok: true, value: { code: 'signed-out' } });
      await expect(
        authenticator.authenticate(market, { token, transport: 'cookie' }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'credential.rejected' },
      });
      const revoked = await sql.query(
        'SELECT revoked_reason FROM identity.sessions WHERE id = $1',
        [sessions.rows[0]!.id],
      );
      expect(revoked.rows).toEqual([{ revoked_reason: 'sign-out' }]);
    });

    it('writes lastSeenAt at most once a minute', async () => {
      const { email } = await verifiedAccount();
      const result = await signIn.execute(context(), {
        email,
        password: PASSWORD,
        client: freshClient(),
      });
      const token = result.ok ? result.value.token : '';
      const lastSeen = async () =>
        (
          await sql.query<{ last_seen_at: Date }>(
            'SELECT last_seen_at FROM identity.sessions WHERE token_hash = $1',
            [Buffer.from(tokens.hashOf(token)!)],
          )
        ).rows[0]!.last_seen_at.getTime();
      const before = await lastSeen();

      clock.advance(Temporal.Duration.from({ seconds: 30 }));
      await authenticator.authenticate(market, { token, transport: 'cookie' });
      expect(await lastSeen()).toBe(before);
      clock.advance(Temporal.Duration.from({ seconds: 31 }));
      await authenticator.authenticate(market, { token, transport: 'cookie' });
      expect(await lastSeen()).toBe(clock.now().epochMilliseconds);
    });

    it('lets 20 concurrent guesses verify no more than the limit (HF1)', async () => {
      const { email } = await verifiedAccount();
      const client = freshClient();
      const limit = policy.signInThrottles(market).accountOrigin.limit;

      const answers = await Promise.all(
        Array.from({ length: 20 }, () =>
          signIn.execute(context(), { email, password: 'wrong guess', client }),
        ),
      );

      const codes = answers.map((a) => (a.ok ? 'signed-in' : a.error.code));
      expect(codes.filter((c) => c === 'credentials.invalid')).toHaveLength(limit);
      expect(codes.filter((c) => c === 'request.throttled')).toHaveLength(20 - limit);
      expect(hasher.verified).toBe(limit);
      const counter = await sql.query<{ attempts: number; blocked_until: Date | null }>(
        `SELECT attempts, blocked_until FROM identity.sign_in_throttles
          WHERE market_id = $1 AND kind = 'sign-in.account-origin' AND key_hash = $2`,
        [
          code,
          Buffer.from(keys.accountOrigin(market, 'customer', email.toLowerCase(), client.origin)),
        ],
      );
      expect(counter.rows[0]!.attempts).toBe(20);
      expect(counter.rows[0]!.blocked_until).not.toBeNull();
      // Even the right password is refused now, and the refusal is recorded.
      await expect(
        signIn.execute(context(), { email, password: PASSWORD, client }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'request.throttled' },
      });
    });

    it('gives a correct password its reservation back', async () => {
      const { email } = await verifiedAccount();
      const client = freshClient();

      await signIn.execute(context(), { email, password: 'wrong guess', client });
      await signIn.execute(context(), { email, password: PASSWORD, client });

      const counters = await sql.query<{ kind: string; attempts: number }>(
        `SELECT kind, attempts FROM identity.sign_in_throttles
          WHERE market_id = $1 AND kind LIKE 'sign-in.%' AND key_hash = ANY($2) ORDER BY kind`,
        [
          code,
          [
            Buffer.from(keys.account(market, 'customer', email.toLowerCase())),
            Buffer.from(keys.accountOrigin(market, 'customer', email.toLowerCase(), client.origin)),
          ],
        ],
      );
      expect(counters.rows).toEqual([
        { kind: 'sign-in.account', attempts: 1 },
        { kind: 'sign-in.account-origin', attempts: 1 },
      ]);
    });

    it('refuses an unverified account after its password (I5) and records it', async () => {
      const email = `Unverified+${randomUUID()}@Example.com`;
      await register.execute(context(), { origin: '192.0.2.1', email, password: PASSWORD });

      await expect(
        signIn.execute(context(), { email, password: PASSWORD, client: freshClient() }),
      ).resolves.toEqual({ ok: false, error: { code: 'email-verification-required' } });
      const records = await sql.query(
        `SELECT r.outcome FROM identity.sign_in_records r JOIN identity.accounts a ON a.id = r.account_id
          WHERE a.email_normalized = $1`,
        [email.toLowerCase()],
      );
      expect(records.rows).toEqual([{ outcome: 'email-verification-required' }]);
    });

    it('identity.purge-expired deletes only what is already invalid', async () => {
      const { email, accountId } = await verifiedAccount();
      const now = clock.now();
      const old = new Date(now.subtract({ hours: 24 * 400 }).epochMilliseconds);
      const recent = new Date(now.subtract({ hours: 1 }).epochMilliseconds);
      const insertSession = async (absoluteExpiresAt: Date) => {
        const id = randomUUID();
        await sql.query(
          `INSERT INTO identity.sessions (id, market_id, tenant_id, account_id, population, token_hash,
             transport, created_at, last_seen_at, idle_timeout_seconds, absolute_expires_at)
           VALUES ($1, $2, 'default', $3, 'customer', $4, 'cookie', $5, $5, 60, $6)`,
          [
            id,
            code,
            accountId,
            randomBytes(32),
            new Date(absoluteExpiresAt.getTime() - 120_000),
            absoluteExpiresAt,
          ],
        );
        return id;
      };
      const expiredLongAgo = await insertSession(old);
      const expiredRecently = await insertSession(recent);
      const keyOf = () => Buffer.from(randomUUID().replace(/-/g, ''), 'hex').subarray(0, 16);
      const oldKey = Buffer.concat([keyOf(), keyOf()]);
      const blockedKey = Buffer.concat([keyOf(), keyOf()]);
      await sql.query(
        `INSERT INTO identity.sign_in_throttles (market_id, tenant_id, kind, key_hash, account_key,
           window_started_at, attempts, blocked_until)
         VALUES ($1, 'default', 'sign-in.origin', $2, NULL, $3, 3, NULL),
                ($1, 'default', 'sign-in.origin', $4, NULL, $3, 3, $5)`,
        [code, oldKey, old, blockedKey, new Date(now.add({ hours: 1 }).epochMilliseconds)],
      );
      const retention = policy.signInRecordRetentionDays(market);
      const recordAt = (hoursAgo: number) =>
        new Date(now.subtract({ hours: hoursAgo }).epochMilliseconds);
      const oldRecord = randomUUID();
      const keptRecord = randomUUID();
      await sql.query(
        `INSERT INTO identity.sign_in_records (id, market_id, tenant_id, population, account_id, outcome,
           occurred_at, origin, session_id, correlation_id)
         VALUES ($1, $3, 'default', 'customer', NULL, 'credentials.invalid', $4, '192.0.2.1', NULL, 'db-purge-0001'),
                ($2, $3, 'default', 'customer', NULL, 'credentials.invalid', $5, '192.0.2.1', NULL, 'db-purge-0002')`,
        [oldRecord, keptRecord, code, recordAt(retention * 24 + 30), recordAt(retention * 24 - 30)],
      );

      const ran = await purge.execute(testCallContext(market, 'system'), {});
      const again = await purge.execute(testCallContext(market, 'system'), {});

      expect(ran.ok && again.ok).toBe(true);
      const sessions = await sql.query<{ id: string }>(
        'SELECT id FROM identity.sessions WHERE id = ANY($1)',
        [[expiredLongAgo, expiredRecently]],
      );
      expect(sessions.rows.map((r) => r.id)).toEqual([expiredRecently]);
      const throttles = await sql.query<{ key_hash: Buffer }>(
        'SELECT key_hash FROM identity.sign_in_throttles WHERE market_id = $1 AND key_hash = ANY($2)',
        [code, [oldKey, blockedKey]],
      );
      expect(throttles.rows.map((r) => r.key_hash.equals(blockedKey))).toEqual([true]);
      const records = await sql.query<{ id: string }>(
        'SELECT id FROM identity.sign_in_records WHERE id = ANY($1)',
        [[oldRecord, keptRecord]],
      );
      expect(records.rows.map((r) => r.id)).toEqual([keptRecord]);
      // The sign-in of this test is recent and stays.
      expect(email).toBeDefined();
    });
  });

  describe('constraints and privileges (data design 3.4 to 3.6, 7)', () => {
    async function violated(statement: Promise<unknown>): Promise<string | null> {
      try {
        await statement;
        return null;
      } catch (error) {
        if (error instanceof DatabaseError) return error.constraint ?? error.code ?? 'unknown';
        throw error;
      }
    }

    it.each(TEST_MARKETS)('refuses malformed rows in %s', async (code) => {
      const insertThrottle = (kind: string, keyHash: Buffer, accountKey: Buffer | null) =>
        sql.query(
          `INSERT INTO identity.sign_in_throttles (market_id, tenant_id, kind, key_hash, account_key,
             window_started_at, attempts) VALUES ($1, 'default', $2, $3, $4, now(), 1)`,
          [code, kind, keyHash, accountKey],
        );
      const key = () => Buffer.from(`${randomUUID()}`.replace(/-/g, '').padEnd(64, '0'), 'hex');

      expect(await violated(insertThrottle('sign-in.everything', key(), key()))).toBe(
        'sign_in_throttles_kind_check',
      );
      expect(await violated(insertThrottle('sign-in.origin', key(), key()))).toBe(
        'sign_in_throttles_account_key_check',
      );
      expect(await violated(insertThrottle('sign-in.account', key(), null))).toBe(
        'sign_in_throttles_account_key_check',
      );
      expect(await violated(insertThrottle('mail.origin', Buffer.alloc(31), null))).toBe(
        'sign_in_throttles_key_hash_check',
      );
      expect(
        await violated(
          sql.query(
            `INSERT INTO identity.sign_in_records (id, market_id, tenant_id, population, outcome, occurred_at,
               origin, correlation_id) VALUES ($1, $2, 'default', 'customer', 'Signed In!', now(), '192.0.2.1', 'db-check-0001')`,
            [randomUUID(), code],
          ),
        ),
      ).toBe('sign_in_records_outcome_check');
    });

    it.each(TEST_MARKETS)('refuses malformed session rows in %s', async (code) => {
      // CHECK constraints fire before the foreign key, so the account need not exist.
      const insertSession = (overrides: {
        population?: string;
        sellerId?: string | null;
        tokenHash?: Buffer;
        transport?: string;
        expiresInSeconds?: number;
        revokedAt?: string | null;
        revokedReason?: string | null;
      }) =>
        sql.query(
          `INSERT INTO identity.sessions (id, market_id, tenant_id, account_id, population, seller_id,
             token_hash, transport, created_at, last_seen_at, idle_timeout_seconds, absolute_expires_at,
             revoked_at, revoked_reason)
           VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, now(), now(), 600,
             now() + make_interval(secs => $8), $9, $10)`,
          [
            randomUUID(),
            code,
            randomUUID(),
            overrides.population ?? 'customer',
            overrides.sellerId === undefined ? null : overrides.sellerId,
            overrides.tokenHash ?? Buffer.alloc(32, 1),
            overrides.transport ?? 'cookie',
            overrides.expiresInSeconds ?? 3600,
            overrides.revokedAt === undefined ? null : overrides.revokedAt,
            overrides.revokedReason === undefined ? null : overrides.revokedReason,
          ],
        );

      expect(await violated(insertSession({ sellerId: randomUUID() }))).toBe(
        'sessions_seller_id_check',
      );
      expect(await violated(insertSession({ population: 'seller' }))).toBe(
        'sessions_seller_id_check',
      );
      expect(await violated(insertSession({ revokedAt: new Date().toISOString() }))).toBe(
        'sessions_revoked_check',
      );
      expect(await violated(insertSession({ tokenHash: Buffer.alloc(31, 1) }))).toBe(
        'sessions_token_hash_check',
      );
      expect(await violated(insertSession({ expiresInSeconds: 0 }))).toBe(
        'sessions_absolute_expires_at_check',
      );
      expect(await violated(insertSession({ transport: 'header' }))).toBe(
        'sessions_transport_check',
      );
    });

    it('gives the application no UPDATE on sign-in records (append-only)', async () => {
      expect(
        await violated(
          sql.query("UPDATE identity.sign_in_records SET outcome = 'signed-in' WHERE false"),
        ),
      ).toBe('42501');
    });
  });
});
