import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  LINK_TOKENS,
  type LinkTokens,
} from '../../src/modules/identity/application/ports/link-secrets';
import {
  ONE_TIME_LINK_REPOSITORY,
  type OneTimeLinkRepository,
} from '../../src/modules/identity/application/ports/one-time-link.repository';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
} from '../../src/modules/identity/application/ports/password-hasher';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import { AdminCancelCustomerEmailChange } from '../../src/modules/identity/application/use-cases/admin-cancel-customer-email-change.use-case';
import { AdminRequestCustomerEmailChange } from '../../src/modules/identity/application/use-cases/admin-request-customer-email-change.use-case';
import { ConfirmCustomerEmailChange } from '../../src/modules/identity/application/use-cases/confirm-customer-email-change.use-case';
import { RequestPasswordReset } from '../../src/modules/identity/application/use-cases/request-password-reset.use-case';
import { ResetPassword } from '../../src/modules/identity/application/use-cases/reset-password.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendEmailChangedMail } from '../../src/modules/identity/application/use-cases/send-email-changed-mail.use-case';
import type { LinkPurpose } from '../../src/modules/identity/domain/one-time-link';
import { openSession } from '../../src/modules/identity/domain/session';
import { issueDelivery } from '../../src/platform/persistence/outbox/delivery-ledger';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../src/platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The admin email change under real concurrency on PostgreSQL (customers admin email change;
// Hassan L3 and M1), for both Market fixtures, as the application role: the real application's
// use cases, repositories and units; only the mail transport captures (and can pause a send).
// Each race starts both sides with Promise.all on separate units (separate pool connections) and
// asserts that the end state is the one of a serial order: exactly one side wins, nothing partial.
// The link mail is issued as SendLinkMail's step 3 does (a token minted, its hash stored at the
// link's version), so no dispatcher runs over other files' events on the shared run database.

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'violet kettle under moonlight';
const ADMIN_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const KEY = 'customers.customer-email.change';
const CLIENT = { origin: '198.51.100.7', address: '198.51.100.7' };
/** A fresh mail origin per call: the Market's per-origin mail counter never refuses a test. */
const freshOrigin = () =>
  `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.9`;
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

/** Captures every mail; a test can run work while one send is in flight. */
class PausingTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  duringNextSend: (() => Promise<void>) | null = null;

  async send(message: MailMessage): Promise<void> {
    const hook = this.duringNextSend;
    this.duringNextSend = null;
    if (hook !== null) await hook();
    this.sent.push(message);
  }
}

describe.each(TEST_MARKETS)('admin email change races in market %s (database)', (code) => {
  const market: MarketContext = marketOf(code);
  const transport = new PausingTransport();
  let app: NestExpressApplication;
  let sql: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl() },
      override: (builder) => builder.overrideProvider(MAIL_TRANSPORT).useValue(transport),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-email-races-${randomUUID()}`), {});
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  beforeEach(() => {
    transport.sent.length = 0;
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const inUnit = <T>(work: () => Promise<T>): Promise<T> =>
    app
      .get<UnitOfWork>(UNIT_OF_WORK)
      .run(market, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unit refused');
        return result.value;
      });
  const now = () => Temporal.Now.instant();
  const anonymous = () => testCallContext(market, 'anonymous', `db-email-races-${randomUUID()}`);
  const system = () => testCallContext(market, 'system', `db-email-races-${randomUUID()}`);

  async function session(
    accountId: Id<'Account'>,
    population: 'admin' | 'customer',
  ): Promise<Id<'Session'>> {
    const sessionId = newId<'Session'>();
    await inUnit(() =>
      app.get<SessionRepository>(SESSION_REPOSITORY).add(
        market,
        openSession({
          id: sessionId,
          marketId: market.marketId,
          accountId,
          population,
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: now(),
        }),
        new Uint8Array(randomBytes(32)),
      ),
    );
    return sessionId;
  }

  /** A Platform Administrator with an active factor and a signed-in session; answers its context. */
  async function administrator(): Promise<CallContext> {
    const accountId = newId<'Account'>();
    const email = `Admin.${accountId}@Admin.example`;
    const at = now().toString();
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, 'Admin', 'active', $5, $5, 1, $5)`,
      [accountId, code, email, email.toLowerCase(), at],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, accountId, ADMIN_PASSWORD_HASH, at],
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
      [newId(), code, accountId, rows[0]!.id, at],
    );
    const factorId = newId<'SecondFactor'>();
    await sql.query(
      `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id, state,
       secret_ciphertext, pending_secret_ciphertext, last_accepted_step, activated_at,
       created_at, version) VALUES ($1, $2, 'default', $3, 'active', $4, NULL, NULL, $5, $5, 1)`,
      [factorId, code, accountId, `v1.${'A'.repeat(60)}`, at],
    );
    for (let position = 1; position <= 10; position += 1) {
      await sql.query(
        `INSERT INTO identity.recovery_codes (market_id, tenant_id, second_factor_id, position,
         code_hash) VALUES ($1, 'default', $2, $3, $4)`,
        [code, factorId, position, randomBytes(32)],
      );
    }
    const sessionId = await session(accountId, 'admin');
    return testCallContext(
      market,
      testAuthenticatedActor(market, { population: 'admin', accountId, sessionId, sellerId: null }),
      `db-email-races-${randomUUID()}`,
    );
  }

  /**
   * A fresh proof of the admin session for the change key (spent by each request or cancel), at
   * millisecond precision as the application writes it (`takeProof` deletes by the value read).
   */
  async function prove(admin: CallContext): Promise<void> {
    const sessionId = (admin.actor as { sessionId: string }).sessionId;
    await sql.query(
      `INSERT INTO identity.step_up_proofs (market_id, tenant_id, session_id, action_key, verified_at)
       VALUES ($1, 'default', $2, $3, date_trunc('milliseconds', now()))
       ON CONFLICT (market_id, session_id, action_key)
       DO UPDATE SET verified_at = date_trunc('milliseconds', now())`,
      [code, sessionId, KEY],
    );
  }

  /** A verified customer with the password and a subject key; answers its id and address. */
  async function customer(): Promise<{ accountId: Id<'Account'>; email: string }> {
    const accountId = newId<'Account'>();
    const email = `Customer.${accountId}@Example.com`;
    const at = now().toString();
    const hashed = await app.get<PasswordHasher>(PASSWORD_HASHER).hash(PASSWORD);
    if (!hashed.ok) throw new Error('test: hasher busy');
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'customer', $3, $4, NULL, 'active', $5, $5, 1, $5)`,
      [accountId, code, email, email.toLowerCase(), at],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, accountId, hashed.value, at],
    );
    await inUnit(() =>
      app.get<SubjectKeyService>(SUBJECT_KEY_SERVICE).createKey(market, accountId as Id),
    );
    return { accountId, email };
  }

  /** Issues the requested link of `purpose` as SendLinkMail's step 3 does; answers the token. */
  async function issue(accountId: Id<'Account'>, purpose: LinkPurpose): Promise<string> {
    const linkTokens = app.get<LinkTokens>(LINK_TOKENS);
    const links = app.get<OneTimeLinkRepository>(ONE_TIME_LINK_REPOSITORY);
    const minted = linkTokens.issue();
    await inUnit(async () => {
      const link = await links.findFor(market, accountId, purpose);
      if (link === null) throw new Error(`test: no ${purpose} link`);
      const issued = link.issue(minted.tokenHash, now(), 60);
      if (!issued.ok) throw new Error('test: the link was not issuable');
      await links.save(market, link);
    });
    return minted.token;
  }

  const request = async (admin: CallContext, accountId: Id<'Account'>, email: string) => {
    await prove(admin);
    return app
      .get(AdminRequestCustomerEmailChange)
      .execute(admin, { accountId, email, origin: freshOrigin() });
  };
  const confirm = (token: string, password = PASSWORD) =>
    app.get(ConfirmCustomerEmailChange).execute(anonymous(), { token, password, client: CLIENT });
  const row = async (accountId: Id<'Account'>) => {
    const { rows } = await sql.query<{
      email: string;
      pending_email: string | null;
      version: number;
    }>('SELECT email, pending_email, version FROM identity.accounts WHERE id = $1', [accountId]);
    return rows[0]!;
  };
  const notices = async (accountId: Id<'Account'>) => {
    const { rows } = await sql.query<{ account_version: number }>(
      `SELECT account_version FROM identity.email_change_notices WHERE account_id = $1
       ORDER BY account_version`,
      [accountId],
    );
    return rows.map((r) => r.account_version);
  };
  const changedEvents = async (accountId: Id<'Account'>) => {
    const { rows } = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM identity.outbox WHERE aggregate_id = $1
       AND type = 'identity.account-email-changed.v1'`,
      [accountId],
    );
    return Number(rows[0]!.n);
  };
  /**
   * The handler of the change's `account-email-changed` event, with the delivery its claim would
   * carry: the real outbox event of that version, issued as the dispatcher issues a claim (no
   * dispatcher runs here: other files' events share this database).
   */
  const sendNotice = async (accountId: Id<'Account'>, aggregateVersion: number) => {
    const { rows } = await sql.query<{ event_id: string }>(
      `SELECT event_id FROM identity.outbox WHERE aggregate_id = $1 AND aggregate_version = $2
       AND type = 'identity.account-email-changed.v1'`,
      [accountId, aggregateVersion],
    );
    const delivery = issueDelivery(
      {
        eventId: rows[0]!.event_id as Id<'event'>,
        subscriber: 'identity.email-changed-mail',
        attempt: 1,
      },
      market,
      now,
    );
    return app.get(SendEmailChangedMail).execute(system(), {
      delivery,
      accountId,
      occurredAt: now(),
      aggregateVersion,
    });
  };

  describe('one notice per change (Hassan M1)', () => {
    it('notices A and B after A to B to C, each with the new address of its own change', async () => {
      const admin = await administrator();
      const { accountId, email: a } = await customer();
      const b = `B.${accountId}@Mailbox.test`;
      const c = `C.${accountId}@Mailbox.test`;
      expect(await request(admin, accountId, b)).toMatchObject({ ok: true });
      expect(await confirm(await issue(accountId, 'confirm-email-change'))).toMatchObject({
        ok: true,
      });
      const ab = (await row(accountId)).version;
      expect(await request(admin, accountId, c)).toMatchObject({ ok: true });
      expect(await confirm(await issue(accountId, 'confirm-email-change'))).toMatchObject({
        ok: true,
      });
      const bc = (await row(accountId)).version;
      expect(await notices(accountId)).toEqual([ab, bc]);
      // Sealed: no address in clear in the table.
      const { rows } = await sql.query<{ previous_email: string; new_email: string }>(
        'SELECT previous_email, new_email FROM identity.email_change_notices WHERE account_id = $1',
        [accountId],
      );
      expect(JSON.stringify(rows).toLowerCase()).not.toContain('example.com');
      expect(JSON.stringify(rows).toLowerCase()).not.toContain('mailbox.test');

      expect(await sendNotice(accountId, bc)).toMatchObject({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      expect(transport.sent.at(-1)!.to).toBe(b);
      expect(await notices(accountId)).toEqual([ab]);
      expect(await sendNotice(accountId, ab)).toMatchObject({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      expect(transport.sent.at(-1)!.to).toBe(a);
      expect(transport.sent.at(-1)!.text).toContain('b***@m***.test');
      expect(await notices(accountId)).toEqual([]);
    });

    it('keeps the notice of a change confirmed while another notice is being sent', async () => {
      const admin = await administrator();
      const { accountId, email: a } = await customer();
      const b = `B.${accountId}@Mailbox.test`;
      const c = `C.${accountId}@Mailbox.test`;
      expect(await request(admin, accountId, b)).toMatchObject({ ok: true });
      expect(await confirm(await issue(accountId, 'confirm-email-change'))).toMatchObject({
        ok: true,
      });
      const ab = (await row(accountId)).version;
      expect(await request(admin, accountId, c)).toMatchObject({ ok: true });
      const token = await issue(accountId, 'confirm-email-change');
      // The handler has read the A to B notice; B to C commits before it deletes its row.
      transport.duringNextSend = async () => {
        expect((await confirm(token)).ok).toBe(true);
      };
      expect(await sendNotice(accountId, ab)).toMatchObject({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      expect(transport.sent.at(-1)!.to).toBe(a);
      const bc = (await row(accountId)).version;
      expect(await notices(accountId)).toEqual([bc]);
      expect(await sendNotice(accountId, bc)).toMatchObject({
        ok: true,
        value: { code: 'email-change-mail.sent' },
      });
      expect(transport.sent.at(-1)!.to).toBe(b);
    });

    it('goes with its account (cascade)', async () => {
      const admin = await administrator();
      const { accountId } = await customer();
      expect(await request(admin, accountId, `B.${accountId}@Mailbox.test`)).toMatchObject({
        ok: true,
      });
      expect(await confirm(await issue(accountId, 'confirm-email-change'))).toMatchObject({
        ok: true,
      });
      expect((await notices(accountId)).length).toBe(1);
      await sql.query('DELETE FROM identity.accounts WHERE id = $1', [accountId]);
      expect(await notices(accountId)).toEqual([]);
    });
  });

  describe('parallel races (Hassan L3)', () => {
    it('two confirmations with one token: exactly one swaps', async () => {
      const admin = await administrator();
      const { accountId } = await customer();
      const b = `B.${accountId}@Mailbox.test`;
      expect(await request(admin, accountId, b)).toMatchObject({ ok: true });
      const token = await issue(accountId, 'confirm-email-change');
      const results = await Promise.all([confirm(token), confirm(token)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error.code)).toEqual([
        'link.rejected',
      ]);
      const after = await row(accountId);
      expect(after.email).toBe(b);
      expect(after.pending_email).toBeNull();
      expect(await notices(accountId)).toHaveLength(1);
      expect(await changedEvents(accountId)).toBe(1);
    });

    it('confirmation against a newer request: one serial order, never both on the old link', async () => {
      const admin = await administrator();
      const { accountId, email: a } = await customer();
      const b = `B.${accountId}@Mailbox.test`;
      const c = `C.${accountId}@Mailbox.test`;
      expect(await request(admin, accountId, b)).toMatchObject({ ok: true });
      const token = await issue(accountId, 'confirm-email-change');
      const [confirmed, requested] = await Promise.all([
        confirm(token),
        request(admin, accountId, c),
      ]);
      const after = await row(accountId);
      if (confirmed.ok) {
        // The confirmation first: B is the address; the request then asks for C from B.
        expect(after.email).toBe(b);
        expect(await notices(accountId)).toHaveLength(1);
        expect(after.pending_email === null || after.pending_email === c).toBe(true);
        expect(after.pending_email === c).toBe(requested.ok);
      } else {
        // The request first: the old link is refused, A stays, C waits.
        expect(confirmed.error.code).toBe('link.rejected');
        expect(requested.ok).toBe(true);
        expect(after.email).toBe(a);
        expect(after.pending_email).toBe(c);
        expect(await notices(accountId)).toEqual([]);
        expect(await changedEvents(accountId)).toBe(0);
      }
    });

    it('confirmation against a cancel: exactly one takes effect', async () => {
      const admin = await administrator();
      const { accountId, email: a } = await customer();
      const b = `B.${accountId}@Mailbox.test`;
      expect(await request(admin, accountId, b)).toMatchObject({ ok: true });
      const token = await issue(accountId, 'confirm-email-change');
      await prove(admin);
      const [confirmed, cancelled] = await Promise.all([
        confirm(token),
        app.get(AdminCancelCustomerEmailChange).execute(admin, { accountId }),
      ]);
      const after = await row(accountId);
      expect(after.pending_email).toBeNull();
      if (confirmed.ok) {
        expect(cancelled).toMatchObject({ ok: false, error: { code: 'email-change.none' } });
        expect(after.email).toBe(b);
        expect(await notices(accountId)).toHaveLength(1);
      } else {
        expect(confirmed.error.code).toBe('link.rejected');
        expect(cancelled).toEqual({ ok: true, value: { code: 'email-change.cancelled' } });
        expect(after.email).toBe(a);
        expect(await notices(accountId)).toEqual([]);
        expect(await changedEvents(accountId)).toBe(0);
      }
    });

    it('confirmation against a password reset: exactly one completes', async () => {
      const admin = await administrator();
      const { accountId, email: a } = await customer();
      const b = `B.${accountId}@Mailbox.test`;
      expect(await request(admin, accountId, b)).toMatchObject({ ok: true });
      const changeToken = await issue(accountId, 'confirm-email-change');
      expect(
        (
          await app
            .get(RequestPasswordReset)
            .execute(anonymous(), { population: 'customer', email: a, origin: freshOrigin() })
        ).ok,
      ).toBe(true);
      const resetToken = await issue(accountId, 'reset-password');
      const [confirmed, reset] = await Promise.all([
        confirm(changeToken),
        app.get(ResetPassword).execute(anonymous(), {
          population: 'customer',
          token: resetToken,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ]);
      expect([confirmed.ok, reset.ok].filter(Boolean)).toHaveLength(1);
      const after = await row(accountId);
      if (confirmed.ok) {
        // The swap cancelled the reset link mailed to the old address.
        expect(after.email).toBe(b);
        expect(await notices(accountId)).toHaveLength(1);
      } else {
        // The reset changed the password the confirmation was checked against.
        expect(after.email).toBe(a);
        expect(after.pending_email).toBe(b);
        expect(await notices(accountId)).toEqual([]);
        expect(await changedEvents(accountId)).toBe(0);
      }
    });
  });
});
