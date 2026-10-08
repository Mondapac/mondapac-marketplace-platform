import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
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
import { SeedSystemRoles } from '../../src/modules/identity/application/use-cases/seed-system-roles.use-case';
import { CLOCK } from '../../src/platform/clock/clock.module';
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
        env: { DATABASE_URL: passwordTestDatabaseUrl() },
        override: (builder) =>
          builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(MAIL_TRANSPORT)
            .useValue(transport),
      }));
      relay = app.get<OutboxRelay>(OUTBOX_RELAY);
      dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
      await app.get(SeedSystemRoles).execute(systemContext(market), {});
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
