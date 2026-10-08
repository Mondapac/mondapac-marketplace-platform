import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepository,
} from '../../src/modules/identity/application/ports/account.repository';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { passwordTestDatabaseUrl } from './test-database';

// Password reset and change end to end on PostgreSQL (identity design 3.5, 3.7, 6.2, 6.3, 6.5,
// 6.6, 9; data design 3.4, 3.7; slice 4), for both Market fixtures and both populations: the
// real application with its controllers, use cases, repositories, relay, dispatcher and mail
// handlers, as the application role. Only the clock is fixed and the mail transport captures.
//
// The race tests prove Hassan's slice-2 N1: a sign-in with the old password that races a reset
// or a change never leaves a live session once the change has committed. Each pauses one side
// right after it took the account's credential lock (or, for the change, after it revoked the
// sessions), starts the other side, waits until PostgreSQL reports that side waiting for a
// lock, then lets the first one finish. The pauses stay well under the application role's
// lock_timeout (3 s). This file runs on its own copy of the run database (global-setup.ts).

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'violet kettle under moonlight';
const NAME = 'Amina Rahman';
const TOKEN_IN_URL = /#(ml1_[A-Za-z0-9_-]{43})$/m;
const POPULATIONS = ['customer', 'seller'] as const;
type Population = (typeof POPULATIONS)[number];

class CapturingTransport implements MailTransport {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  to(address: string): MailMessage[] {
    return this.sent.filter((mail) => mail.to === address);
  }
}

const tokenOf = (mail: MailMessage): string => {
  const match = TOKEN_IN_URL.exec(mail.text);
  if (match === null) throw new Error('the mail carries no link token');
  return match[1]!;
};

const cookieOf = (response: request.Response): string =>
  (response.headers['set-cookie'] as unknown as string[])[0]!.split(';', 1)[0]!;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that the test resolves, and one that tells when the paused side got there. */
function pausePoint(): {
  reached: Promise<void>;
  arrive: () => void;
  go: () => void;
  wait: Promise<void>;
} {
  let arrive!: () => void;
  let go!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const wait = new Promise<void>((resolve) => (go = resolve));
  return { reached, arrive, go, wait };
}

describe.each(TEST_MARKETS)(
  'password reset and change in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
    const transport = new CapturingTransport();
    let app: NestExpressApplication;
    let sql: Client;
    let relay: OutboxRelay;
    let dispatcher: EventDispatcher;
    let logs: jest.SpyInstance[];

    beforeAll(async () => {
      sql = new Client({ connectionString: passwordTestDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await sql.end();
    });

    // One application per test: the per-origin request limiter counts in its memory.
    beforeEach(async () => {
      ({ app } = await createTestApp({
        env: { DATABASE_URL: passwordTestDatabaseUrl(), API_DOCS_ENABLED: 'true' },
        override: (builder) =>
          builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(MAIL_TRANSPORT)
            .useValue(transport),
      }));
      relay = app.get<OutboxRelay>(OUTBOX_RELAY);
      dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
      await app.get(SeedRoles).execute(systemContext(market), {});
    });
    afterEach(async () => {
      await app.close();
    });

    beforeEach(() => {
      // A new day per test: the mail and sign-in counters of an earlier test have expired.
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      transport.sent.length = 0;
      logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    });
    afterEach(() => logs.forEach((spy) => spy.mockRestore()));

    const systemContext = (m: MarketContext) =>
      testCallContext(m, 'system', `db-password-${randomUUID()}`);
    const http = () => request(app.getHttpServer());
    const post = (
      population: Population,
      path: string,
      body: object,
      headers: Record<string, string> = {},
    ) =>
      http()
        .post(`/identity/${population}/${path}`)
        .set({ 'x-market-id': code, ...headers })
        .send(body);
    const sessionOf = (population: Population, cookie: string) =>
      http().get(`/identity/${population}/session`).set({ 'x-market-id': code, cookie });

    async function settle(): Promise<void> {
      for (;;) {
        const published = (await relay.runOnce()).published;
        const claimed = (await dispatcher.runOnce()).claimed;
        if (published === 0 && claimed === 0) return;
      }
    }

    /** Signs up and confirms by the mailed link (which signs in); answers the first session. */
    async function verified(population: Population) {
      const email = `Pass.Word+${randomUUID()}@Example.com`;
      const body =
        population === 'seller'
          ? { displayName: NAME, email, password: PASSWORD }
          : { email, password: PASSWORD };
      expect((await post(population, 'sign-up', body)).status).toBe(202);
      await settle();
      const confirmed = await post(population, 'confirm-email', {
        token: tokenOf(transport.to(email).at(-1)!),
        password: PASSWORD,
      });
      expect(confirmed.status).toBe(200);
      // The welcome mail of the sign-up goes out now, before the test starts.
      await settle();
      transport.sent.length = 0;
      const accountId = (
        await sql.query<{ id: string }>(
          `SELECT id FROM identity.accounts WHERE market_id = $1 AND population = $2
          AND email_normalized = $3`,
          [code, population, email.toLowerCase()],
        )
      ).rows[0]!.id;
      return {
        email,
        accountId,
        cookie: cookieOf(confirmed),
        csrfToken: (confirmed.body as { csrfToken: string }).csrfToken,
      };
    }

    /** Asks for a reset link and answers its token from the mail. */
    async function resetToken(population: Population, email: string): Promise<string> {
      const asked = await post(population, 'password-reset-email', { email });
      expect(asked.status).toBe(202);
      expect(asked.body).toEqual({ code: 'password-reset.accepted' });
      await settle();
      return tokenOf(transport.to(email).at(-1)!);
    }

    const liveSessions = async (accountId: string) =>
      (
        await sql.query<{ id: string }>(
          `SELECT id FROM identity.sessions WHERE market_id = $1 AND account_id = $2
          AND revoked_at IS NULL ORDER BY id`,
          [code, accountId],
        )
      ).rows.map((r) => r.id);

    /**
     * An open sign-in challenge and an active second factor of the account, stored as slice 7
     * stores them, so a test sees what a reset or a change voids (HF11; Hassan I2 (d)) and what
     * it keeps (Hassan I2 (a)).
     */
    async function openChallengeAndFactor(accountId: string): Promise<void> {
      const now = new Date(clock.now().epochMilliseconds);
      const expires = new Date(clock.now().add({ minutes: 5 }).epochMilliseconds);
      await sql.query(
        `INSERT INTO identity.sign_in_challenges (id, market_id, tenant_id, account_id, purpose,
           token_hash, attempts, credential_changed_at, expires_at, consumed_at, created_at)
         VALUES ($1, $2, 'default', $3, 'second-factor', $4, 0, $5, $6, NULL, $5)`,
        [uuidV7(Date.now(), randomBytes(10)), code, accountId, randomBytes(32), now, expires],
      );
      const factorId = uuidV7(Date.now(), randomBytes(10));
      await sql.query(
        `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id, state,
           secret_ciphertext, last_accepted_step, activated_at, created_at, version)
         VALUES ($1, $2, 'default', $3, 'active', 'ciphertext', NULL, $4, $4, 1)`,
        [factorId, code, accountId, now],
      );
      // An active factor holds all ten codes (data design 3.10): slice 7b's reset and change load
      // the factor to clear a waiting replacement, and the aggregate refuses one without them.
      for (let position = 1; position <= 10; position += 1) {
        await sql.query(
          `INSERT INTO identity.recovery_codes (market_id, tenant_id, second_factor_id, position,
             code_hash) VALUES ($1, 'default', $2, $3, $4)`,
          [code, factorId, position, randomBytes(32)],
        );
      }
    }

    const challengesAndFactors = async (accountId: string) =>
      (
        await sql.query<{ challenges: number; factors: number }>(
          `SELECT (SELECT count(*)::int FROM identity.sign_in_challenges
                    WHERE market_id = $1 AND account_id = $2) AS challenges,
                  (SELECT count(*)::int FROM identity.second_factors
                    WHERE market_id = $1 AND account_id = $2 AND state = 'active') AS factors`,
          [code, accountId],
        )
      ).rows[0]!;

    /**
     * Waits until a statement of this database waits for a lock, or `pending` settles first.
     * "blocked" proves the two units serialise on the account's credential lock.
     */
    async function blockedOrSettled(pending: Promise<unknown>): Promise<'blocked' | 'settled'> {
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (settled) return 'settled';
        const { rows } = await sql.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (rows[0]!.n > 0) return 'blocked';
        await sleep(5);
      }
      throw new Error('neither blocked nor settled within 2 s');
    }

    /** Pauses the next `lockCredential` right after it took the lock (the sign-in's, here). */
    function pauseNextCredentialLock() {
      const accounts = app.get<AccountRepository>(ACCOUNT_REPOSITORY);
      const original = accounts.lockCredential.bind(accounts);
      const point = pausePoint();
      let armed = true;
      accounts.lockCredential = async (m, id) => {
        const locked = await original(m, id);
        if (armed) {
          armed = false;
          point.arrive();
          await point.wait;
        }
        return locked;
      };
      return point;
    }

    /** Pauses the next `revokeAllOf` right after it ran (inside the reset's or change's unit). */
    function pauseAfterNextRevokeAll() {
      const sessions = app.get<SessionRepository>(SESSION_REPOSITORY);
      const original = sessions.revokeAllOf.bind(sessions);
      const point = pausePoint();
      let armed = true;
      sessions.revokeAllOf = async (m, accountId, reason, now, exceptId) => {
        const revoked = await original(m, accountId, reason, now, exceptId);
        if (armed) {
          armed = false;
          point.arrive();
          await point.wait;
        }
        return revoked;
      };
      return point;
    }

    describe.each(POPULATIONS)('for the %s population', (population) => {
      it('resets with the mailed link: every session ends, the link works once, a notice is mailed', async () => {
        const { email, accountId, cookie } = await verified(population);
        const second = await post(population, 'sign-in', { email, password: PASSWORD });
        expect(second.status).toBe(200);
        // A wrong guess leaves a counter that the reset clears (3.5).
        expect((await post(population, 'sign-in', { email, password: 'wrong guess' })).status).toBe(
          401,
        );
        expect(await liveSessions(accountId)).toHaveLength(2);

        const token = await resetToken(population, email);
        const link = (
          await sql.query<{ expires_at: Date; issued_at: Date }>(
            `SELECT expires_at, issued_at FROM identity.one_time_links WHERE market_id = $1
            AND account_id = $2 AND purpose = 'reset-password'`,
            [code, accountId],
          )
        ).rows[0]!;
        expect(link.expires_at.getTime() - link.issued_at.getTime()).toBe(60 * 60_000);

        // (The anonymous identity routes allow 10 requests a minute per origin in ZZ: this test
        // stays within them; unknown addresses and non-JSON bodies have their own test.)
        const weak = await post(population, 'reset-password', { token, password: 'short' });
        expect(weak.body).toEqual({
          statusCode: 400,
          code: 'password.rejected',
          details: { rule: 'length' },
        });
        const reset = await post(population, 'reset-password', { token, password: NEW_PASSWORD });
        expect(reset.status).toBe(200);
        expect(reset.body).toEqual({ code: 'password-changed' });
        expect(reset.headers['set-cookie']).toBeUndefined();

        expect(await liveSessions(accountId)).toEqual([]);
        const reasons = await sql.query<{ revoked_reason: string }>(
          'SELECT DISTINCT revoked_reason FROM identity.sessions WHERE market_id = $1 AND account_id = $2',
          [code, accountId],
        );
        expect(reasons.rows).toEqual([{ revoked_reason: 'password-reset' }]);
        expect((await sessionOf(population, cookie)).status).toBe(401);
        const counters = await sql.query(
          `SELECT 1 FROM identity.sign_in_throttles WHERE market_id = $1 AND kind IN
          ('sign-in.account', 'sign-in.account-origin') AND account_key IS NOT NULL
          AND window_started_at >= $2`,
          [code, new Date(clock.now().epochMilliseconds)],
        );
        expect(counters.rows).toEqual([]);
        // The address's mail budget is not refilled by a reset (Mojtaba, slice 4).
        const mailCounters = await sql.query(
          `SELECT 1 FROM identity.sign_in_throttles WHERE market_id = $1 AND kind = 'mail.account'
          AND window_started_at >= $2`,
          [code, new Date(clock.now().epochMilliseconds)],
        );
        expect(mailCounters.rows.length).toBeGreaterThanOrEqual(1);
        // A sign-in record keeps where the reset came from, with the request's correlation id,
        // which the route's log line carries too (Hassan L3; Sajad Q4).
        const correlationId = reset.headers['x-correlation-id'] as string;
        const records = await sql.query<{ outcome: string; session_id: string | null }>(
          `SELECT outcome, session_id FROM identity.sign_in_records WHERE market_id = $1
          AND account_id = $2 AND correlation_id = $3`,
          [code, accountId, correlationId],
        );
        expect(records.rows).toEqual([{ outcome: 'password-reset', session_id: null }]);
        expect(logs[0]!.mock.calls).toContainEqual([
          expect.objectContaining({
            msg: `identity.${population}-reset-password`,
            outcome: 'password-changed',
            correlationId,
          }),
        ]);
        const consumed = await sql.query<{ consumed_at: Date | null }>(
          `SELECT consumed_at FROM identity.one_time_links WHERE market_id = $1 AND account_id = $2
          AND purpose = 'reset-password'`,
          [code, accountId],
        );
        expect(consumed.rows[0]!.consumed_at).not.toBeNull();
        const events = await sql.query<{ payload: unknown }>(
          `SELECT payload FROM identity.outbox WHERE market_id = $1 AND aggregate_id = $2
          AND type = 'identity.account-password-changed.v1'`,
          [code, accountId],
        );
        expect(events.rows).toEqual([{ payload: { accountId, cause: 'reset' } }]);

        // The link works once; the old password is gone, the new one signs in.
        expect(
          (await post(population, 'reset-password', { token, password: 'another long password' }))
            .body,
        ).toEqual({ statusCode: 400, code: 'link.rejected' });
        expect((await post(population, 'sign-in', { email, password: PASSWORD })).status).toBe(401);
        expect((await post(population, 'sign-in', { email, password: NEW_PASSWORD })).status).toBe(
          200,
        );

        // The notice goes out once the event is dispatched, with no link.
        await settle();
        const notice = transport.to(email).at(-1)!;
        expect(notice.text).not.toContain('ml1_');
        if (code === 'AU') {
          expect(notice.subject).toBe(
            `The password for your MondaPac ${population} account was changed`,
          );
        }
      });

      it('answers an unknown address like a known one, mails nothing, and takes JSON only', async () => {
        const unknown = await post(population, 'password-reset-email', {
          email: `Nobody+${randomUUID()}@Example.com`,
        });
        expect(unknown.status).toBe(202);
        expect(unknown.body).toEqual({ code: 'password-reset.accepted' });
        await settle();
        expect(transport.sent).toEqual([]);

        for (const path of ['password-reset-email', 'reset-password', 'change-password']) {
          const notJson = await http()
            .post(`/identity/${population}/${path}`)
            .set({ 'x-market-id': code, 'content-type': 'text/plain' })
            .send('email=someone@example.com');
          expect(notJson.status).toBe(415);
        }
      });

      it('changes in session: the session gets a new token, every other session ends, a notice is mailed', async () => {
        const { email, accountId, cookie, csrfToken } = await verified(population);
        const other = await post(population, 'sign-in', { email, password: PASSWORD });
        const otherCookie = cookieOf(other);

        const withoutCsrf = await post(
          population,
          'change-password',
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          { cookie },
        );
        expect(withoutCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
        const anonymous = await post(population, 'change-password', {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        });
        expect(anonymous.status).toBe(401);
        const missing = await post(
          population,
          'change-password',
          { currentPassword: PASSWORD },
          { cookie, 'x-csrf-token': csrfToken },
        );
        expect(missing.body).toMatchObject({ statusCode: 400, code: 'validation.failed' });

        const wrong = await post(
          population,
          'change-password',
          { currentPassword: 'not my password', newPassword: NEW_PASSWORD },
          { cookie, 'x-csrf-token': csrfToken },
        );
        expect(wrong.body).toEqual({ statusCode: 400, code: 'password.current-incorrect' });

        const changed = await post(
          population,
          'change-password',
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          { cookie, 'x-csrf-token': csrfToken },
        );
        expect(changed.status).toBe(200);
        expect(changed.body).toEqual({
          code: 'password-changed',
          csrfToken: expect.any(String) as unknown,
        });
        expect(changed.headers['cache-control']).toBe('no-store');
        const rotated = cookieOf(changed);
        expect(rotated).not.toBe(cookie);

        expect((await sessionOf(population, cookie)).status).toBe(401);
        expect((await sessionOf(population, otherCookie)).status).toBe(401);
        expect((await sessionOf(population, rotated)).status).toBe(200);
        expect(await liveSessions(accountId)).toHaveLength(1);
        const reasons = await sql.query<{ revoked_reason: string }>(
          `SELECT revoked_reason FROM identity.sessions WHERE market_id = $1 AND account_id = $2
          AND revoked_at IS NOT NULL`,
          [code, accountId],
        );
        expect(reasons.rows).toEqual([{ revoked_reason: 'password-changed' }]);
        // Hassan L3: the wrong guess and the change are sign-in records of the session.
        const records = await sql.query<{ outcome: string; session_id: string }>(
          `SELECT r.outcome, r.session_id FROM identity.sign_in_records r WHERE r.market_id = $1
          AND r.account_id = $2 AND r.outcome IN ('password.current-incorrect', 'password-changed')
          ORDER BY r.outcome DESC`,
          [code, accountId],
        );
        expect(records.rows.map((r) => r.outcome)).toEqual([
          'password.current-incorrect',
          'password-changed',
        ]);
        expect(new Set(records.rows.map((r) => r.session_id)).size).toBe(1);
        expect((await post(population, 'sign-in', { email, password: PASSWORD })).status).toBe(401);

        await settle();
        const notice = transport.to(email).at(-1)!;
        expect(notice.text).not.toContain('ml1_');
        if (code === 'AU') {
          expect(notice.subject).toBe(
            `The password for your MondaPac ${population} account was changed`,
          );
        }
      });

      it('a change cancels a reset link requested before it (Hassan L2)', async () => {
        const { email, cookie, csrfToken } = await verified(population);
        const token = await resetToken(population, email);

        const changed = await post(
          population,
          'change-password',
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          { cookie, 'x-csrf-token': csrfToken },
        );
        expect(changed.status).toBe(200);
        const reset = await post(population, 'reset-password', {
          token,
          password: 'another long passphrase',
        });
        expect(reset.body).toEqual({ statusCode: 400, code: 'link.rejected' });
        expect((await post(population, 'sign-in', { email, password: NEW_PASSWORD })).status).toBe(
          200,
        );
      });

      it('a reset voids the open challenges, keeps the second factor and its HF2 block, and opens no session (HF11; Hassan I2 (a), (d), I-4)', async () => {
        const { email, accountId } = await verified(population);
        // A wrong guess leaves the address's sign-in counters; an HF2 block sits beside them.
        expect((await post(population, 'sign-in', { email, password: 'wrong guess' })).status).toBe(
          401,
        );
        const { rows: signIn } = await sql.query<{ account_key: Buffer }>(
          `SELECT account_key FROM identity.sign_in_throttles WHERE market_id = $1
          AND kind = 'sign-in.account' ORDER BY window_started_at DESC LIMIT 1`,
          [code],
        );
        const accountKey = signIn[0]!.account_key;
        const factorKey = randomBytes(32);
        await sql.query(
          `INSERT INTO identity.sign_in_throttles (market_id, tenant_id, kind, key_hash,
             account_key, window_started_at, attempts, blocked_until)
           VALUES ($1, 'default', 'second-factor.account', $2, $3, $4, 10, $5)`,
          [
            code,
            factorKey,
            accountKey,
            new Date(clock.now().epochMilliseconds),
            new Date(clock.now().add({ hours: 24 }).epochMilliseconds),
          ],
        );
        const token = await resetToken(population, email);
        await openChallengeAndFactor(accountId);
        expect(await challengesAndFactors(accountId)).toEqual({ challenges: 1, factors: 1 });

        const reset = await post(population, 'reset-password', { token, password: NEW_PASSWORD });

        expect(reset.status).toBe(200);
        expect(reset.headers['set-cookie']).toBeUndefined();
        expect(await challengesAndFactors(accountId)).toEqual({ challenges: 0, factors: 1 });
        expect(await liveSessions(accountId)).toEqual([]);
        // Ali 2026-10-08 (I-4, 6.8): nothing lifts the HF2 block early, a reset included; only the
        // two sign-in counters of the address go.
        const { rows: left } = await sql.query<{ kind: string }>(
          `SELECT kind FROM identity.sign_in_throttles WHERE market_id = $1 AND account_key = $2
          ORDER BY kind`,
          [code, accountKey],
        );
        expect(left.map((r) => r.kind)).not.toContain('sign-in.account');
        expect(left.map((r) => r.kind)).toContain('second-factor.account');
      });

      it('a change voids the open challenges and keeps the second factor (HF11; Hassan I2 (d))', async () => {
        const { accountId, cookie, csrfToken } = await verified(population);
        await openChallengeAndFactor(accountId);

        const changed = await post(
          population,
          'change-password',
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          { cookie, 'x-csrf-token': csrfToken },
        );

        expect(changed.status).toBe(200);
        expect(await challengesAndFactors(accountId)).toEqual({ challenges: 0, factors: 1 });
      });

      it('refuses an expired link over HTTP (SEL-05, ACC-04; Sajad Q3)', async () => {
        const { email } = await verified(population);
        const token = await resetToken(population, email);
        clock.advance(Temporal.Duration.from({ minutes: 60 }));

        const reset = await post(population, 'reset-password', { token, password: NEW_PASSWORD });

        expect(reset.body).toEqual({ statusCode: 400, code: 'link.rejected' });
        expect((await post(population, 'sign-in', { email, password: PASSWORD })).status).toBe(200);
      });

      it('two uses of one link at once: exactly one succeeds (3.7; Sajad Q1)', async () => {
        const { email, accountId } = await verified(population);
        const token = await resetToken(population, email);

        const answers = await Promise.all([
          post(population, 'reset-password', { token, password: NEW_PASSWORD }),
          post(population, 'reset-password', { token, password: 'another long passphrase' }),
        ]);

        const statuses = answers.map((a) => a.status).sort();
        expect(statuses).toEqual([200, 400]);
        expect(answers.find((a) => a.status === 400)!.body).toEqual({
          statusCode: 400,
          code: 'link.rejected',
        });
        const events = await sql.query(
          `SELECT 1 FROM identity.outbox WHERE market_id = $1 AND aggregate_id = $2
          AND type = 'identity.account-password-changed.v1'`,
          [code, accountId],
        );
        expect(events.rows).toHaveLength(1);
      });

      it('two changes from one session at once: exactly one succeeds (Sajad Q1)', async () => {
        const { accountId, cookie, csrfToken } = await verified(population);
        const change = (newPassword: string) =>
          post(
            population,
            'change-password',
            { currentPassword: PASSWORD, newPassword },
            { cookie, 'x-csrf-token': csrfToken },
          );

        const answers = await Promise.all([
          change(NEW_PASSWORD),
          change('another long passphrase'),
        ]);

        expect(answers.map((a) => a.status).sort()).toEqual([200, 400]);
        expect(answers.find((a) => a.status === 400)!.body).toEqual({
          statusCode: 400,
          code: 'password.current-incorrect',
        });
        const winner = answers.find((a) => a.status === 200)!;
        expect((await sessionOf(population, cookieOf(winner))).status).toBe(200);
        expect(await liveSessions(accountId)).toHaveLength(1);
      });

      it('limits the three routes per origin with the anonymous identity class (Hassan L4; Sajad Q6)', async () => {
        const limit = app.get(MarketRegistry).get(market.marketId)
          .requestLimits.anonymousIdentityPerMinute;
        for (let i = 0; i < limit; i += 1) {
          const path = i % 2 === 0 ? 'password-reset-email' : 'reset-password';
          const body =
            i % 2 === 0
              ? { email: `Nobody+${randomUUID()}@Example.com` }
              : { token: 'ml1_unknown', password: NEW_PASSWORD };
          expect([202, 400]).toContain((await post(population, path, body)).status);
        }

        for (const path of ['password-reset-email', 'reset-password', 'change-password']) {
          const over = await post(population, path, { email: 'someone@example.com' });
          expect(over.status).toBe(429);
          expect(over.body).toMatchObject({ code: 'request.throttled' });
        }
      });

      it('documents the three routes in the OpenAPI document (Sajad Q5)', async () => {
        const docs = await http().get('/docs-json').expect(200);
        const paths = (docs.body as { paths: Record<string, { post?: unknown }> }).paths;
        for (const path of ['password-reset-email', 'reset-password', 'change-password']) {
          expect(paths[`/identity/${population}/${path}`]?.post).toBeDefined();
        }
      });

      describe('Hassan slice-2 N1: a racing sign-in with the old password leaves no live session', () => {
        it('a sign-in that took the lock first commits, then the reset revokes its session', async () => {
          const { email, accountId } = await verified(population);
          const token = await resetToken(population, email);
          const pause = pauseNextCredentialLock();

          const signIn = post(population, 'sign-in', { email, password: PASSWORD }).then((r) => r);
          await pause.reached;
          const reset = post(population, 'reset-password', { token, password: NEW_PASSWORD }).then(
            (r) => r,
          );
          expect(await blockedOrSettled(reset)).toBe('blocked');
          pause.go();
          const [signedIn, wasReset] = await Promise.all([signIn, reset]);

          expect(signedIn.status).toBe(200);
          expect(wasReset.status).toBe(200);
          expect((await sessionOf(population, cookieOf(signedIn))).status).toBe(401);
          expect(await liveSessions(accountId)).toEqual([]);
        });

        it('a sign-in that took the lock first commits, then the change revokes its session', async () => {
          const { email, accountId, cookie, csrfToken } = await verified(population);
          const pause = pauseNextCredentialLock();

          const signIn = post(population, 'sign-in', { email, password: PASSWORD }).then((r) => r);
          await pause.reached;
          const change = post(
            population,
            'change-password',
            { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
            { cookie, 'x-csrf-token': csrfToken },
          ).then((r) => r);
          expect(await blockedOrSettled(change)).toBe('blocked');
          pause.go();
          const [signedIn, changed] = await Promise.all([signIn, change]);

          expect(signedIn.status).toBe(200);
          expect(changed.status).toBe(200);
          expect((await sessionOf(population, cookieOf(signedIn))).status).toBe(401);
          // Only the changing session lives on, with its new token.
          const rotated = cookieOf(changed);
          expect((await sessionOf(population, rotated)).status).toBe(200);
          expect(await liveSessions(accountId)).toHaveLength(1);
        });

        it('a sign-in that reaches the lock after the reset revoked waits, then reads the new password', async () => {
          const { email, accountId } = await verified(population);
          const token = await resetToken(population, email);
          const pause = pauseAfterNextRevokeAll();

          const reset = post(population, 'reset-password', { token, password: NEW_PASSWORD }).then(
            (r) => r,
          );
          await pause.reached;
          const signIn = post(population, 'sign-in', { email, password: PASSWORD }).then((r) => r);
          expect(await blockedOrSettled(signIn)).toBe('blocked');
          pause.go();
          const [wasReset, signedIn] = await Promise.all([reset, signIn]);

          expect(wasReset.status).toBe(200);
          expect(signedIn.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });
          expect(await liveSessions(accountId)).toEqual([]);
        });

        it('a sign-in that reaches the lock after the change revoked waits, then reads the new password', async () => {
          const { email, accountId, cookie, csrfToken } = await verified(population);
          const pause = pauseAfterNextRevokeAll();

          const change = post(
            population,
            'change-password',
            { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
            { cookie, 'x-csrf-token': csrfToken },
          ).then((r) => r);
          await pause.reached;
          const signIn = post(population, 'sign-in', { email, password: PASSWORD }).then((r) => r);
          expect(await blockedOrSettled(signIn)).toBe('blocked');
          pause.go();
          const [changed, signedIn] = await Promise.all([change, signIn]);

          expect(changed.status).toBe(200);
          expect(signedIn.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });
          expect(await liveSessions(accountId)).toHaveLength(1);
          expect((await sessionOf(population, cookieOf(changed))).status).toBe(200);
        });
      });
    });
  },
);
