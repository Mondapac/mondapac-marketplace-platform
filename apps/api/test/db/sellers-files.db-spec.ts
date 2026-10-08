import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { SeedSystemRoles } from '../../src/modules/identity/application/use-cases/seed-system-roles.use-case';
import { SELLERS_FACADE, type SellersFacade } from '../../src/modules/sellers';
import { BackfillSellerFiles } from '../../src/modules/sellers/application/use-cases/backfill-seller-files.use-case';
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
import { sellerFilesOwnerTestDatabaseUrl, sellerFilesTestDatabaseUrl } from './test-database';

// Sellers slice 1 on PostgreSQL (sellers design 7.1, 7.5, 14.3 Q-M4; data design 3.1, 3.7 to
// 3.9, 3.12, 8), for both Market fixtures: a seller registers through the real identity flow, the
// relay and the dispatcher run `sellers.create-file`, and the file with its three roots, the
// event and the inbox row are read back as the application role. The backfill, `sellerSummaries`
// and the constraints are checked on the same rows. This file runs on its own copy of the run
// database (global-setup.ts): the relay and the dispatcher claim every due row of a Market.

const PASSWORD = 'correct horse battery staple';
const TOKEN_IN_URL = /#(ml1_[A-Za-z0-9_-]{43})$/m;

class CapturingTransport implements MailTransport {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

const tokenOf = (mail: MailMessage): string => {
  const match = TOKEN_IN_URL.exec(mail.text);
  if (match === null) throw new Error('the mail carries no link token');
  return match[1]!;
};

describe.each(TEST_MARKETS)('sellers files in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = code === 'AU' ? 'ZZ' : 'AU';
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
  const transport = new CapturingTransport();
  let app: NestExpressApplication;
  let sql: Client;
  let owner: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    sql = new Client({ connectionString: sellerFilesTestDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: sellerFilesOwnerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
  });

  beforeEach(async () => {
    // A new application and a new day per test: the rate limits and the mail and sign-in
    // counters of an earlier test do not carry over.
    clock.advance(Temporal.Duration.from({ hours: 25 }));
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    ({ app } = await createTestApp({
      env: { DATABASE_URL: sellerFilesTestDatabaseUrl() },
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(MAIL_TRANSPORT)
          .useValue(transport),
    }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    await app.get(SeedSystemRoles).execute(systemContext(market.marketId), {});
  });
  afterEach(async () => {
    await app.close();
    logs.forEach((spy) => spy.mockRestore());
  });

  const systemContext = (marketCode: string) =>
    testCallContext(marketOf(marketCode), 'system', `db-sellers-${randomUUID()}`);
  const anonymousContext = (marketCode: string) =>
    testCallContext(marketOf(marketCode), 'anonymous', `db-sellers-${randomUUID()}`);
  const facade = () => app.get<SellersFacade>(SELLERS_FACADE);
  const approvalRequired = (marketCode: string) =>
    app.get(MarketRegistry).get(marketOf(marketCode).marketId).sellers?.approvalRequired ?? true;

  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  /** Signs a seller up and confirms the email in `marketCode`; answers the seller id. */
  async function registerSeller(marketCode: string): Promise<Id<'Seller'>> {
    const email = `Seller.Owner+${randomUUID()}@Example.com`;
    const post = (path: string, body: object) =>
      request(app.getHttpServer())
        .post(`/identity/seller/${path}`)
        .set({ 'x-market-id': marketCode })
        .send(body);
    const signedUp = await post('sign-up', {
      displayName: 'Amina Rahman',
      email,
      password: PASSWORD,
    });
    expect(signedUp.status).toBe(202);
    await settle();
    const mail = transport.sent.filter((message) => message.to === email)[0]!;
    expect((await post('confirm-email', { token: tokenOf(mail), password: PASSWORD })).status).toBe(
      200,
    );
    await settle();
    const { rows } = await sql.query<{ seller_id: string }>(
      `SELECT m.seller_id FROM identity.seller_memberships m
         JOIN identity.accounts a ON a.market_id = m.market_id AND a.id = m.account_id
        WHERE a.market_id = $1 AND a.email_normalized = $2`,
      [marketCode, email.toLowerCase()],
    );
    return rows[0]!.seller_id as Id<'Seller'>;
  }

  const fileOf = async (marketCode: string, sellerId: string) =>
    (
      await sql.query<Record<string, unknown>>(
        `SELECT seller_id, market_id, tenant_id, origin, approval_required_at_registration,
                draft_complete, last_changed_at = created_at AS unchanged, version
           FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2`,
        [marketCode, sellerId],
      )
    ).rows;

  it('creates the file, its three roots, the event and the inbox row from seller-registered, once', async () => {
    const sellerId = await registerSeller(code);

    expect(await fileOf(code, sellerId)).toEqual([
      {
        seller_id: sellerId,
        market_id: code,
        tenant_id: market.tenantId,
        origin: 'self',
        approval_required_at_registration: approvalRequired(code),
        draft_complete: false,
        unchanged: true,
        version: 1,
      },
    ]);
    const roots = async (table: string) =>
      (
        await sql.query<Record<string, unknown>>(
          `SELECT * FROM sellers.${table} WHERE market_id = $1 AND seller_id = $2`,
          [code, sellerId],
        )
      ).rows;
    expect(await roots('seller_admin_settings')).toEqual([
      expect.objectContaining({
        all_product_types_allowed: true,
        category_proposals_allowed: false,
        ai_enabled: false,
        all_product_types_changed_at: null,
        category_proposals_changed_by_account_id: null,
        ai_enabled_changed_at: null,
        version: 1,
      }),
    ]);
    expect(await roots('seller_tax_profiles')).toHaveLength(1);
    expect(await roots('store_profiles')).toHaveLength(1);

    const { rows: events } = await sql.query<{
      payload: unknown;
      aggregate_type: string;
      aggregate_version: number;
      causation_id: string | null;
      published_at: Date | null;
    }>(
      `SELECT payload, aggregate_type, aggregate_version, causation_id, published_at
         FROM sellers.outbox WHERE market_id = $1 AND aggregate_id = $2`,
      [code, sellerId],
    );
    expect(events).toEqual([
      {
        payload: { sellerId },
        aggregate_type: 'seller-file',
        aggregate_version: 1,
        causation_id: expect.any(String) as string,
        published_at: expect.any(Date) as Date,
      },
    ]);
    const { rows: inbox } = await sql.query<{ handler: string; event_id: string }>(
      'SELECT handler, event_id FROM sellers.inbox WHERE market_id = $1',
      [code],
    );
    expect(inbox.filter((row) => row.handler === 'sellers.create-file')).toHaveLength(
      (await sql.query('SELECT 1 FROM sellers.seller_files WHERE market_id = $1', [code]))
        .rowCount!,
    );

    // A second pass, and a redelivery of the same event, change nothing.
    await settle();
    expect(await fileOf(code, sellerId)).toHaveLength(1);
    expect(
      (await sql.query('SELECT 1 FROM sellers.outbox WHERE aggregate_id = $1', [sellerId]))
        .rowCount,
    ).toBe(1);
  });

  it('backfills a registered seller whose file is missing, and only that one, idempotently', async () => {
    const lacking = await registerSeller(code);
    const kept = await registerSeller(code);
    const keptBefore = await fileOf(code, kept);
    // The owner removes a file, its roots and its event, as the state before sellers slice 1
    // shipped (the outbox is unique per aggregate and version).
    await owner.query('DELETE FROM sellers.outbox WHERE market_id = $1 AND aggregate_id = $2', [
      code,
      lacking,
    ]);
    for (const table of [
      'seller_admin_settings',
      'seller_tax_profiles',
      'store_profiles',
      'seller_files',
    ]) {
      await owner.query(`DELETE FROM sellers.${table} WHERE market_id = $1 AND seller_id = $2`, [
        code,
        lacking,
      ]);
    }
    expect(await fileOf(code, lacking)).toHaveLength(0);

    const first = await app.get(BackfillSellerFiles).execute(systemContext(code), {});
    const second = await app.get(BackfillSellerFiles).execute(systemContext(code), {});

    expect(first.ok && first.value.created).toBe(1);
    expect(first.ok && first.value.failed).toBe(0);
    expect(second.ok && second.value.created).toBe(0);
    expect(await fileOf(code, lacking)).toEqual([
      expect.objectContaining({
        seller_id: lacking,
        origin: 'self',
        approval_required_at_registration: approvalRequired(code),
        draft_complete: false,
        version: 1,
      }),
    ]);
    expect(await fileOf(code, kept)).toEqual(keptBefore);
    expect(
      (
        await sql.query(
          `SELECT 1 FROM sellers.store_profiles WHERE market_id = $1 AND seller_id = $2`,
          [code, lacking],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('answers sellerSummaries alike to the anonymous and the system caller, never across Markets', async () => {
    const sellerId = await registerSeller(code);
    await app.get(SeedSystemRoles).execute(systemContext(other), {});
    const elsewhere = await registerSeller(other);
    const never = new SequenceIdGenerator(clock).next<'Seller'>();
    const ids = [never, sellerId, elsewhere, sellerId];

    const asAnonymous = await facade().sellerSummaries(anonymousContext(code), ids);
    const asSystem = await facade().sellerSummaries(systemContext(code), ids);

    expect(asAnonymous).toEqual({
      ok: true,
      value: [
        { sellerId: never, exists: false },
        { sellerId, exists: true },
        { sellerId: elsewhere, exists: false },
      ],
    });
    expect(JSON.stringify(asSystem)).toBe(JSON.stringify(asAnonymous));
  });

  it('answers sellingEligibility false for everyone, whoever calls (stand-in until slice 9)', async () => {
    const sellerId = await registerSeller(code);
    const never = new SequenceIdGenerator(clock).next<'Seller'>();

    for (const context of [anonymousContext(code), systemContext(code)]) {
      const result = await facade().sellingEligibility(context, [sellerId, never]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect([...result.value]).toEqual([
          [sellerId, { eligible: false }],
          [never, { eligible: false }],
        ]);
      }
    }
  });

  it('refuses what the database must refuse: another module`s event type, a file in another Market', async () => {
    const sellerId = await registerSeller(code);

    await expect(
      sql.query(
        `INSERT INTO sellers.outbox (event_id, type, occurred_at, market_id, tenant_id,
           aggregate_type, aggregate_id, aggregate_version, correlation_id, payload)
         VALUES ($1, 'identity.seller-registered.v1', now(), $2, 'default', 'seller-file',
                 $3, 99, 'correlation-0001', '{}')`,
        [randomUUID(), code, sellerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'outbox_type_check' });
    await expect(
      sql.query(
        `INSERT INTO sellers.store_profiles (seller_id, market_id, tenant_id, version, created_at)
         VALUES ($1, $2, 'default', 1, now())`,
        [randomUUID(), other],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      sql.query('DELETE FROM sellers.seller_files WHERE seller_id = $1', [sellerId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql.query('UPDATE sellers.seller_files SET version = 0 WHERE seller_id = $1', [sellerId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'seller_files_version_check' });
  });
});
