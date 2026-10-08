import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { PurgeExpired } from '../../src/modules/identity/application/use-cases/purge-expired.use-case';
import { PurgeUnverifiedAccounts } from '../../src/modules/identity/application/use-cases/purge-unverified-accounts.use-case';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import {
  MAIL_TRANSPORT,
  MailSendError,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { mailTestDatabaseUrl } from './test-database';

// Customer email verification end to end on PostgreSQL (identity design 3.2, 3.7, 6.6, 6.7, 9,
// 12.2; data design 3.7, 3.8, 9; slice 3), for both Market fixtures: the real application with
// its controllers, use cases, repositories, relay, in-process bus, dispatcher and mail handlers,
// as the application role. Only the clock is fixed and the mail transport captures what it is
// given. This file runs on its own copy of the run database (global-setup.ts): the relay and the
// dispatcher claim every due row of a Market.

const PASSWORD = 'correct horse battery staple';
const TOKEN_IN_URL = /#(ml1_[A-Za-z0-9_-]{43})$/m;

/** Captures sent mail; `down` makes every send fail as an unreachable relay does. */
class CapturingTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  down = false;

  send(message: MailMessage): Promise<void> {
    if (this.down) return Promise.reject(new MailSendError('mail.transport-unreachable'));
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The mails sent to `address`, in order. */
  to(address: string): MailMessage[] {
    return this.sent.filter((mail) => mail.to === address);
  }
}

const tokenOf = (mail: MailMessage): string => {
  const match = TOKEN_IN_URL.exec(mail.text);
  if (match === null) throw new Error('the mail carries no link token');
  return match[1]!;
};
const sha256 = (token: string): Buffer => createHash('sha256').update(token).digest();

/** A response body as the API answers it: a code and, for a validation error, details. */
const bodyOf = (response: { body: unknown }) =>
  response.body as { readonly code?: string; readonly details?: unknown };

describe.each(TEST_MARKETS)(
  'customer email verification in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
    const transport = new CapturingTransport();
    let app: NestExpressApplication;
    let sql: Client;
    let relay: OutboxRelay;
    let dispatcher: EventDispatcher;
    let logs: jest.SpyInstance[];

    // One application per test: the per-origin request limiter counts in its memory (PF I11).
    beforeEach(async () => {
      ({ app } = await createTestApp({
        env: { DATABASE_URL: mailTestDatabaseUrl() },
        override: (builder) =>
          builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(MAIL_TRANSPORT)
            .useValue(transport),
      }));
      relay = app.get<OutboxRelay>(OUTBOX_RELAY);
      dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    });
    afterEach(async () => {
      await app.close();
    });

    beforeAll(async () => {
      sql = new Client({ connectionString: mailTestDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await sql.end();
    });

    beforeEach(() => {
      // A new day per test: the mail and sign-in counters of an earlier test have expired.
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      transport.down = false;
      logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    });
    afterEach(() => logs.forEach((spy) => spy.mockRestore()));

    const http = () => request(app.getHttpServer());
    const signUp = (email: string) =>
      http()
        .post('/identity/customer/sign-up')
        .set({ 'x-market-id': code })
        .send({ email, password: PASSWORD });
    const confirm = (token: string, password = PASSWORD) =>
      http()
        .post('/identity/customer/confirm-email')
        .set({ 'x-market-id': code })
        .send({ token, password });
    const resend = (email: string) =>
      http()
        .post('/identity/customer/verification-email')
        .set({ 'x-market-id': code })
        .send({ email });
    const systemContext = () => testCallContext(market, 'system', `db-mail-${randomUUID()}`);
    const newAddress = () => `Verify.Me+${randomUUID()}@Example.com`;

    /** Relays and dispatches until nothing is left to do now. */
    async function settle(): Promise<void> {
      for (;;) {
        const published = (await relay.runOnce()).published;
        const claimed = (await dispatcher.runOnce()).claimed;
        if (published === 0 && claimed === 0) return;
      }
    }

    const accountOf = async (email: string) =>
      (
        await sql.query<{ id: string; email_verified_at: Date | null }>(
          'SELECT id, email_verified_at FROM identity.accounts WHERE market_id = $1 AND email_normalized = $2',
          [code, email.toLowerCase()],
        )
      ).rows[0];

    const linksOf = async (accountId: string) =>
      (
        await sql.query<{
          id: string;
          token_hash: Buffer | null;
          expires_at: Date | null;
          consumed_at: Date | null;
        }>(
          `SELECT id, token_hash, expires_at, consumed_at FROM identity.one_time_links
          WHERE market_id = $1 AND account_id = $2`,
          [code, accountId],
        )
      ).rows;

    const deliveriesOf = async (subscriber: string, aggregateId: string) =>
      (
        await sql.query<{ status: string; attempts: number; error_code: string | null }>(
          `SELECT status, attempts, error_code FROM platform.event_delivery
          WHERE market_id = $1 AND subscriber = $2 AND aggregate_id = $3 ORDER BY created_at`,
          [code, subscriber, aggregateId],
        )
      ).rows;

    it('signs up, mails a working one-time link in the Market locale, and confirms the email', async () => {
      const email = newAddress();
      expect((await signUp(email)).status).toBe(202);
      expect(transport.to(email)).toEqual([]); // nothing is sent inside the request

      await settle();

      const [mail] = transport.to(email);
      expect(transport.to(email)).toHaveLength(1);
      const { identity } = app.get(MarketRegistry).get(market.marketId);
      expect(mail!.from).toEqual({
        address: identity.mail.fromAddress,
        name: identity.mail.fromName,
      });
      expect(mail!.text).toContain(`${identity.links.targets.customer['verify-email']}#ml1_`);
      expect(mail!.text).not.toMatch(/<[a-z]/i);
      const token = tokenOf(mail!);
      const account = (await accountOf(email))!;
      const [link] = await linksOf(account.id);
      expect(link!.token_hash!.equals(sha256(token))).toBe(true);
      expect(await deliveriesOf('identity.link-mail', link!.id)).toEqual([
        { status: 'delivered', attempts: 1, error_code: null },
      ]);

      // Signed in by the link and the password (Hassan I5): the email is verified.
      const confirmed = await confirm(token);
      expect(confirmed.status).toBe(200);
      const [cookie] = confirmed.headers['set-cookie'] as unknown as string[];
      expect(cookie).toMatch(new RegExp(`^__Host-session-customer-${code}=ms1_`));
      expect((await accountOf(email))!.email_verified_at).not.toBeNull();
      expect((await linksOf(account.id))[0]!.consumed_at).not.toBeNull();
      const { rows: verified } = await sql.query(
        `SELECT 1 FROM identity.outbox WHERE market_id = $1 AND aggregate_id = $2
          AND type = 'identity.account-email-verified.v1'`,
        [code, account.id],
      );
      expect(verified).toHaveLength(1);
      expect((await confirm(token)).body).toEqual({ statusCode: 400, code: 'link.rejected' });
    });

    it('refuses the link in another Market, and a wrong password leaves it usable', async () => {
      const email = newAddress();
      await signUp(email);
      await settle();
      const token = tokenOf(transport.to(email)[0]!);
      const other = code === 'AU' ? 'ZZ' : 'AU';

      const elsewhere = await http()
        .post('/identity/customer/confirm-email')
        .set({ 'x-market-id': other })
        .send({ token, password: PASSWORD });
      const wrong = await confirm(token, 'not the password at all');

      expect([elsewhere.status, bodyOf(elsewhere).code]).toEqual([400, 'link.rejected']);
      expect([wrong.status, bodyOf(wrong).code]).toEqual([401, 'credentials.invalid']);
      expect((await confirm(token)).status).toBe(200);
    });

    it('"send it again" mails a new link and voids the earlier one', async () => {
      const email = newAddress();
      await signUp(email);
      await settle();
      const first = tokenOf(transport.to(email)[0]!);

      expect((await resend(email)).status).toBe(202);
      await settle();

      const mails = transport.to(email);
      expect(mails).toHaveLength(2);
      const second = tokenOf(mails[1]!);
      expect(second).not.toBe(first);
      expect(bodyOf(await confirm(first)).code).toBe('link.rejected');
      expect((await confirm(second)).status).toBe(200);
    });

    it('sends one mail when "send it again" comes before the first mail went out (at least once, any order)', async () => {
      const email = newAddress();
      await signUp(email);
      await resend(email);

      await settle();

      const mails = transport.to(email);
      expect(mails).toHaveLength(1);
      const account = (await accountOf(email))!;
      const [link] = await linksOf(account.id);
      expect(await deliveriesOf('identity.link-mail', link!.id)).toEqual([
        { status: 'delivered', attempts: 1, error_code: null },
        { status: 'delivered', attempts: 1, error_code: null },
      ]);
      expect((await confirm(tokenOf(mails[0]!))).status).toBe(200);
    });

    it('retries a mail the relay could not take, after its back-off, and issues the link only then', async () => {
      const email = newAddress();
      await signUp(email);
      transport.down = true;

      await settle();

      const account = (await accountOf(email))!;
      const [link] = await linksOf(account.id);
      expect(link!.token_hash).toBeNull();
      expect(await deliveriesOf('identity.link-mail', link!.id)).toEqual([
        { status: 'pending', attempts: 1, error_code: 'delivery.handler-failed' },
      ]);

      transport.down = false;
      clock.advance(Temporal.Duration.from({ seconds: 30 }));
      await settle();

      expect(transport.to(email)).toHaveLength(1);
      expect((await linksOf(account.id))[0]!.token_hash).not.toBeNull();
      expect((await confirm(tokenOf(transport.to(email)[0]!))).status).toBe(200);
    });

    it('a repeated sign-up of a verified address mails the existing-account notice with no link (E12)', async () => {
      const email = newAddress();
      await signUp(email);
      await settle();
      await confirm(tokenOf(transport.to(email)[0]!));

      expect((await signUp(email)).status).toBe(202);
      await settle();

      const mails = transport.to(email);
      expect(mails).toHaveLength(2);
      expect(mails[1]!.text).not.toContain('ml1_');
      expect(mails[1]!.subject).not.toBe(mails[0]!.subject);
    });

    it('purges unverified accounts after the retention, keeps verified ones, and purges spent links', async () => {
      const unverified = newAddress();
      const verified = newAddress();
      await signUp(unverified);
      await signUp(verified);
      await settle();
      const staleToken = tokenOf(transport.to(unverified)[0]!);
      await confirm(tokenOf(transport.to(verified)[0]!));
      const keptId = (await accountOf(verified))!.id;
      const goneId = (await accountOf(unverified))!.id;

      // A consumed link is kept 24 hours after it was spent.
      await app.get(PurgeExpired).execute(systemContext(), {});
      expect(await linksOf(keptId)).toHaveLength(1);

      // Not yet: the retention has not passed.
      const early = await app.get(PurgeUnverifiedAccounts).execute(systemContext(), {});
      expect(early.ok).toBe(true);
      expect(await accountOf(unverified)).toBeDefined();

      clock.advance(Temporal.Duration.from({ hours: 31 * 24 }));
      const purged = await app.get(PurgeUnverifiedAccounts).execute(systemContext(), {});

      expect(purged).toMatchObject({ ok: true });
      expect(purged.ok && purged.value.deleted).toBeGreaterThanOrEqual(1);
      expect(await accountOf(unverified)).toBeUndefined();
      expect(await linksOf(goneId)).toEqual([]);
      expect((await accountOf(verified))!.id).toBe(keptId);
      expect(bodyOf(await confirm(staleToken)).code).toBe('link.rejected');

      // Then the spent link is purged.
      const swept = await app.get(PurgeExpired).execute(systemContext(), {});
      expect(swept.ok && swept.value.links).toBeGreaterThanOrEqual(1);
      expect(await linksOf(keptId)).toEqual([]);
    });
  },
);
