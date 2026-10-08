import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { PurgeUnverifiedAccounts } from '../../src/modules/identity/application/use-cases/purge-unverified-accounts.use-case';
import { SeedSystemRoles } from '../../src/modules/identity/application/use-cases/seed-system-roles.use-case';
import { IDENTITY_FACADE, type IdentityFacade } from '../../src/modules/identity';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { sellerTestDatabaseUrl } from './test-database';

// Seller self-registration, confirmation, limited sign-in, the facade reads, the welcome mail and
// the purge on PostgreSQL (identity design 3.1, 3.3, 5.5, 5.6, 6.1 to 6.4, 6.7, 8.1, 8.2, 9; data
// design 3.9; slice 5), for both Market fixtures: the real application with its controllers,
// use cases, repositories, relay, in-process bus, dispatcher and mail handlers, as the
// application role. Only the clock is fixed and the mail transport captures what it is given.
// This file runs on its own copy of the run database (global-setup.ts): the relay and the
// dispatcher claim every due row of a Market.

const PASSWORD = 'correct horse battery staple';
const NAME = 'Amina Rahman';
const TOKEN_IN_URL = /#(ml1_[A-Za-z0-9_-]{43})$/m;

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

describe.each(TEST_MARKETS)('seller accounts in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
  const transport = new CapturingTransport();
  let app: NestExpressApplication;
  let sql: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let logs: jest.SpyInstance[];

  beforeEach(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: sellerTestDatabaseUrl() },
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(MAIL_TRANSPORT)
          .useValue(transport),
    }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    await app.get(SeedSystemRoles).execute(systemContext(), {});
  });
  afterEach(async () => {
    await app.close();
  });

  beforeAll(async () => {
    sql = new Client({ connectionString: sellerTestDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(() => {
    // A new day per test: the mail and sign-in counters of an earlier test have expired.
    clock.advance(Temporal.Duration.from({ hours: 25 }));
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    http()
      .post(`/identity/seller/${path}`)
      .set({ 'x-market-id': code, ...headers })
      .send(body);
  const signUp = (email: string) =>
    post('sign-up', { displayName: NAME, email, password: PASSWORD });
  const systemContext = () => testCallContext(market, 'system', `db-seller-${randomUUID()}`);
  const newAddress = () => `Seller.Owner+${randomUUID()}@Example.com`;
  const identity = () => app.get(MarketRegistry).get(market.marketId).identity;
  const expectedState = () => (identity().sellerApprovalRequired ? 'pending' : 'approved');

  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  /** The seller rows of an owner's address, read as the application role. */
  async function rowsOf(email: string) {
    const account = (
      await sql.query<{ id: string; email_verified_at: Date | null; display_name: string }>(
        `SELECT id, email_verified_at, display_name FROM identity.accounts
          WHERE market_id = $1 AND population = 'seller' AND email_normalized = $2`,
        [code, email.toLowerCase()],
      )
    ).rows[0];
    if (account === undefined) return undefined;
    const membership = (
      await sql.query<{ seller_id: string; state: string }>(
        'SELECT seller_id, state FROM identity.seller_memberships WHERE market_id = $1 AND account_id = $2',
        [code, account.id],
      )
    ).rows;
    const sellerId = membership[0]?.seller_id;
    const access = (
      await sql.query<{ state: string; origin: string; registered_at: Date | null }>(
        'SELECT state, origin, registered_at FROM identity.seller_access WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId ?? '00000000-0000-0000-0000-000000000000'],
      )
    ).rows[0];
    const assignment = (
      await sql.query<{ scope: string; kind: string; assigned_by_account_id: string | null }>(
        `SELECT r.scope, r.kind, a.assigned_by_account_id
          FROM identity.role_assignments a JOIN identity.roles r ON r.id = a.role_id
          WHERE a.market_id = $1 AND a.account_id = $2`,
        [code, account.id],
      )
    ).rows;
    return { account, membership, sellerId, access, assignment };
  }

  const keyOf = async (subject: string) =>
    (
      await sql.query<{ destroyed_at: Date | null }>(
        'SELECT destroyed_at FROM platform.subject_keys WHERE subject_id = $1',
        [subject],
      )
    ).rows[0];

  /** Signs up and confirms by the mailed link; answers the address and the confirmation. */
  async function registered() {
    const email = newAddress();
    expect((await signUp(email)).status).toBe(202);
    await settle();
    const confirmed = await post('confirm-email', {
      token: tokenOf(transport.to(email)[0]!),
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    return { email, confirmed };
  }

  it('seeds one system role per scope, idempotently', async () => {
    await app.get(SeedSystemRoles).execute(systemContext(), {});

    const { rows } = await sql.query<{ scope: string; seed_code: string }>(
      `SELECT scope, seed_code FROM identity.roles WHERE market_id = $1 AND kind = 'system'
        ORDER BY scope`,
      [code],
    );
    expect(rows).toEqual([
      { scope: 'platform', seed_code: 'platform-administrator' },
      { scope: 'seller', seed_code: 'seller-owner' },
    ]);
  });

  it('signs up the founding rows, mails the seller link, and confirming registers the seller once', async () => {
    const email = newAddress();
    expect((await signUp(email)).status).toBe(202);

    const before = (await rowsOf(email))!;
    expect(before.account).toMatchObject({ email_verified_at: null, display_name: NAME });
    expect(before.membership).toEqual([{ seller_id: before.sellerId, state: 'active' }]);
    expect(before.access).toEqual({ state: expectedState(), origin: 'self', registered_at: null });
    expect(before.assignment).toEqual([
      { scope: 'seller', kind: 'system', assigned_by_account_id: null },
    ]);
    expect(await keyOf(before.sellerId!)).toEqual({ destroyed_at: null });

    await settle();
    const [mail] = transport.to(email);
    expect(mail!.text).toContain(`${identity().links.targets.seller!['verify-email']}#ml1_`);

    const confirmed = await post('confirm-email', { token: tokenOf(mail!), password: PASSWORD });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ sellerAccess: expectedState() });
    expect((confirmed.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      new RegExp(`^__Host-session-seller-${code}=ms1_[^;]+; Path=/`),
    );
    const after = (await rowsOf(email))!;
    expect(after.access!.registered_at).not.toBeNull();
    const { rows: events } = await sql.query<{ payload: unknown }>(
      `SELECT payload FROM identity.outbox WHERE market_id = $1 AND aggregate_id = $2
        AND type = 'identity.seller-registered.v1'`,
      [code, after.sellerId],
    );
    expect(events).toEqual([
      {
        payload: {
          sellerId: after.sellerId,
          ownerAccountId: after.account.id,
          origin: 'self',
          accessState: expectedState(),
        },
      },
    ]);
    const { rows: sessions } = await sql.query<{ seller_id: string; population: string }>(
      'SELECT seller_id, population FROM identity.sessions WHERE market_id = $1 AND account_id = $2',
      [code, after.account.id],
    );
    expect(sessions).toEqual([{ seller_id: after.sellerId, population: 'seller' }]);

    // The welcome mail goes out once the event is dispatched; the link mail had the token.
    await settle();
    const mails = transport.to(email);
    expect(mails).toHaveLength(2);
    expect(mails[1]!.text).not.toContain('ml1_');
    expect(mails[1]!.text).toContain(identity().links.targets.seller!['sign-in']);
  });

  it('signs in with "keep me signed in", reads the session and status, then the facade answers', async () => {
    const { email } = await registered();
    const { sellerId } = (await rowsOf(email))!;

    const signedIn = await post('sign-in', { email, password: PASSWORD, keepSignedIn: true });
    expect(signedIn.status).toBe(200);
    const [setCookie] = signedIn.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toMatch(/; Max-Age=\d+; /);
    const cookie = setCookie!.split(';', 1)[0]!;

    const session = await http()
      .get('/identity/seller/session')
      .set({ 'x-market-id': code, cookie });
    const status = await http().get('/identity/seller/status').set({ 'x-market-id': code, cookie });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ sellerId, sellerAccessState: expectedState() });
    expect(session.body).toHaveProperty('roleId', expect.any(String));
    expect(status.body).toMatchObject({ sellerId, state: expectedState(), reason: null });

    const facade = app.get<IdentityFacade>(IDENTITY_FACADE);
    await expect(
      facade.sellerAccessOf(systemContext(), [sellerId as Id<'Seller'>]),
    ).resolves.toEqual({
      ok: true,
      value: [expect.objectContaining({ sellerId, state: expectedState() })],
    });
    const items: unknown[] = [];
    let after: Id<'Seller'> | null = null;
    for (;;) {
      const page = await facade.listRegisteredSellers(systemContext(), { after, limit: 500 });
      if (!page.ok) throw new Error('listRegisteredSellers failed');
      items.push(...page.value.items);
      if (page.value.next === null) break;
      after = page.value.next;
    }
    expect(items).toContainEqual({ sellerId, origin: 'self' });
  });

  it('a suspended seller cannot sign in, and its open session stops', async () => {
    const { email, confirmed } = await registered();
    const { sellerId } = (await rowsOf(email))!;
    const cookie = (confirmed.headers['set-cookie'] as unknown as string[])[0]!.split(';', 1)[0]!;
    // Decisions arrive with slice 9; the test sets the state as the owner of the database.
    const owner = new Client({ connectionString: process.env.TEST_SELLER_OWNER_DATABASE_URL });
    await owner.connect();
    try {
      await owner.query(
        `UPDATE identity.seller_access SET state = 'suspended', version = version + 1
          WHERE market_id = $1 AND seller_id = $2`,
        [code, sellerId],
      );
    } finally {
      await owner.end();
    }

    const signIn = await post('sign-in', { email, password: PASSWORD });
    const session = await http()
      .get('/identity/seller/session')
      .set({ 'x-market-id': code, cookie });

    expect(signIn.body).toEqual({ statusCode: 403, code: 'seller-access.suspended' });
    expect(session.body).toEqual({ statusCode: 401, code: 'session.invalid' });
  });

  it('two sign-ups of one new address at once make one seller', async () => {
    const email = newAddress();

    const answers = await Promise.all([signUp(email), signUp(email)]);

    expect(answers.map((a) => a.status)).toEqual([202, 202]);
    const rows = (await rowsOf(email))!;
    expect(rows.membership).toHaveLength(1);
    const { rows: owned } = await sql.query(
      `SELECT 1 FROM identity.accounts WHERE market_id = $1 AND population = 'seller'
        AND email_normalized = $2`,
      [code, email.toLowerCase()],
    );
    expect(owned).toHaveLength(1);
  });

  it('purges a never-verified owner with its membership, assignment and unregistered seller', async () => {
    const email = newAddress();
    await signUp(email);
    const { account, sellerId } = (await rowsOf(email))!;
    const { email: kept } = await registered();

    clock.advance(Temporal.Duration.from({ hours: 31 * 24 }));
    const purged = await app.get(PurgeUnverifiedAccounts).execute(systemContext(), {});

    expect(purged.ok && purged.value.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(email)).toBeUndefined();
    const { rows: left } = await sql.query(
      `SELECT 1 FROM identity.seller_access WHERE market_id = $1 AND seller_id = $2
        UNION ALL SELECT 1 FROM identity.role_assignments WHERE market_id = $1 AND account_id = $3`,
      [code, sellerId, account.id],
    );
    expect(left).toEqual([]);
    expect((await keyOf(sellerId!))!.destroyed_at).not.toBeNull();
    expect((await keyOf(account.id))!.destroyed_at).not.toBeNull();
    // A registered seller and its owner stay.
    expect((await rowsOf(kept))!.access!.registered_at).not.toBeNull();
  });
});
