import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { SeedSystemRoles } from '../../src/modules/identity/application/use-cases/seed-system-roles.use-case';
import { SELLERS_FACADE, type SellersFacade } from '../../src/modules/sellers';
import { BackfillSellerFiles } from '../../src/modules/sellers/application/use-cases/backfill-seller-files.use-case';
import { MyFileCheckSlug } from '../../src/modules/sellers/application/use-cases/my-file-check-slug.use-case';
import { MyFileRead } from '../../src/modules/sellers/application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from '../../src/modules/sellers/application/use-cases/my-file-save-address.use-case';
import { MyFileSaveGeneral } from '../../src/modules/sellers/application/use-cases/my-file-save-general.use-case';
import { AUTHORISATION_CHECK, type AuthorisationCheck } from '../../src/platform/authz';
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

/**
 * Stands in for identity slice 8a (the permission registry and role keys): until then identity's
 * check refuses every `permissions` rule. The Seller Owner system role holds every seller key, so
 * this admits an authenticated seller actor under a `permissions` rule and nothing else; the
 * sellers use cases still check ownership and the access state themselves.
 */
const sellerOwnerCheck: AuthorisationCheck = {
  check: (context, declaration) =>
    Promise.resolve(
      context.actor.kind === 'authenticated' &&
        context.actor.population === 'seller' &&
        context.actor.sellerId !== null &&
        declaration.rule.kind === 'permissions'
        ? { allowed: true }
        : { allowed: false, denial: { code: 'access.denied' } },
    ),
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
          .useValue(transport)
          .overrideProvider(AUTHORISATION_CHECK)
          .useValue(sellerOwnerCheck),
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

  // Slice 2 (migration sellers_file_details; data design 3.1, 3.5, 3.11): what the database holds.
  describe('slice 2 columns, shop slugs and rate counters', () => {
    const refuses = (statement: string, params: unknown[], constraint: string) =>
      expect(sql.query(statement, params)).rejects.toMatchObject({ code: '23514', constraint });
    const update = (sellerId: string, set: string, params: unknown[] = []) =>
      sql.query(`UPDATE sellers.seller_files SET ${set} WHERE seller_id = $1`, [
        sellerId,
        ...params,
      ]);

    /**
     * A well-formed placeholder ciphertext of `length` characters: the v1 envelope shape
     * ("v1." and base64url; 41 characters is the envelope of an empty plaintext, data design 4.5).
     */
    const ciphertext = (length: number) => `v1.${'A'.repeat(length - 3)}`;

    it('holds a complete draft and refuses what its CHECKs refuse', async () => {
      const sellerId = await registerSeller(code);
      const zone = code === 'AU' ? 'Australia/Brisbane' : 'Asia/Tokyo';

      await update(
        sellerId,
        `store_name = 'Al Noor', store_name_key = 'al noor', business_name_ciphertext = $2,
         phone_ciphertext = $2, address_ciphertext = $2, service_area_code = 'greater-brisbane',
         operating_timezone = $3, address_timezone = $3, timezone_source = 'default'`,
        [ciphertext(41), zone],
      );

      const bad: [string, unknown[], string][] = [
        ["store_name = ' padded', store_name_key = 'padded'", [], 'seller_files_store_name_check'],
        ["store_name = 'padded ', store_name_key = 'padded'", [], 'seller_files_store_name_check'],
        ["store_name = '', store_name_key = 'a'", [], 'seller_files_store_name_check'],
        ["store_name = 'a' || chr(1), store_name_key = 'a'", [], 'seller_files_store_name_check'],
        // U+0085 (C1), U+202E (bidi override), U+061C (Arabic letter mark).
        ["store_name = 'a' || chr(133), store_name_key = 'a'", [], 'seller_files_store_name_check'],
        [
          "store_name = 'a' || chr(8238), store_name_key = 'a'",
          [],
          'seller_files_store_name_check',
        ],
        [
          "store_name = 'a' || chr(1564), store_name_key = 'a'",
          [],
          'seller_files_store_name_check',
        ],
        [
          "store_name = repeat('a', 101), store_name_key = 'a'",
          [],
          'seller_files_store_name_check',
        ],
        ['store_name = NULL', [], 'seller_files_store_name_key_pair_check'],
        ['store_name_key = NULL', [], 'seller_files_store_name_key_pair_check'],
        ["store_name_key = 'Upper'", [], 'seller_files_store_name_key_check'],
        ["store_name_key = ' al noor'", [], 'seller_files_store_name_key_check'],
        ["store_name_key = ''", [], 'seller_files_store_name_key_check'],
        // U+FB01 (the "fi" ligature) is not NFKC-normalised.
        ['store_name_key = chr(64257)', [], 'seller_files_store_name_key_check'],
        ["store_name_key = repeat('a', 401)", [], 'seller_files_store_name_key_check'],
        ["service_area_code = 'Bad Code'", [], 'seller_files_service_area_code_check'],
        ["operating_timezone = '+10:00'", [], 'seller_files_operating_timezone_check'],
        [
          "operating_timezone = 'Aa/Bb/Cc/Dd', timezone_source = 'seller'",
          [],
          'seller_files_operating_timezone_check',
        ],
        [
          "operating_timezone = repeat('A', 65), timezone_source = 'seller'",
          [],
          'seller_files_operating_timezone_check',
        ],
        [
          "address_timezone = '+10:00', timezone_source = 'seller'",
          [],
          'seller_files_address_timezone_check',
        ],
        [
          "address_timezone = repeat('A', 65), timezone_source = 'seller'",
          [],
          'seller_files_address_timezone_check',
        ],
        ["timezone_source = 'gps'", [], 'seller_files_timezone_source_check'],
        ['timezone_source = NULL', [], 'seller_files_timezone_set_check'],
        ['operating_timezone = NULL', [], 'seller_files_timezone_set_check'],
        ['address_timezone = NULL', [], 'seller_files_timezone_set_check'],
        [
          "timezone_source = 'default', operating_timezone = 'Pacific/Auckland'",
          [],
          'seller_files_timezone_default_check',
        ],
        ['address_ciphertext = NULL', [], 'seller_files_timezone_address_check'],
      ];
      // Every ciphertext column: accepted at its bound, refused one above it, below the empty
      // envelope (41) and in any other shape.
      const bounds = [
        ['business_name', 2048],
        ['phone', 512],
        ['contact_email', 2048],
        ['address', 16384],
        ['registered_address', 16384],
      ] as const;
      for (const [column, bound] of bounds) {
        const constraint = `seller_files_${column}_ciphertext_check`;
        await update(sellerId, `${column}_ciphertext = $2`, [ciphertext(bound)]);
        bad.push(
          [`${column}_ciphertext = $2`, [ciphertext(bound + 1)], constraint],
          [`${column}_ciphertext = $2`, [ciphertext(40)], constraint],
          [`${column}_ciphertext = $2`, ['x'.repeat(41)], constraint],
          [`${column}_ciphertext = $2`, [`v1.${'/'.repeat(38)}`], constraint],
          [`${column}_ciphertext = ''`, [], constraint],
        );
      }
      for (const [set, params, constraint] of bad) {
        await refuses(
          `UPDATE sellers.seller_files SET ${set} WHERE seller_id = $1`,
          [sellerId, ...params],
          constraint,
        );
      }
      // A chosen zone may differ from the address zone once the source says so.
      await update(sellerId, `operating_timezone = 'Pacific/Auckland', timezone_source = 'seller'`);

      // The plain prefix-search index (A6) exists as Prisma declares it.
      const index = await owner.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'sellers' AND indexname = 'seller_files_market_id_store_name_key_idx'`,
      );
      expect(index.rows.map((row) => row.indexdef)).toEqual([
        'CREATE INDEX seller_files_market_id_store_name_key_idx ON sellers.seller_files USING btree (market_id, store_name_key)',
      ]);
    });

    it('stores slugs with the C collation, unique per Market, one held per seller, never deleted', async () => {
      const sellerId = await registerSeller(code);
      const insert = (market: string, slug: string, seller: string, state = 'held', ever = false) =>
        sql.query(
          `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state,
             ever_public, held_at, retired_at, version, created_at)
           VALUES ($1, $2, 'default', $3, $4, $5, $6, now(),
                   CASE WHEN $5 = 'retired' THEN now() END, 1, now())`,
          [randomUUID(), market, slug, seller, state, ever],
        );
      /** An insert with every column given, for the CHECKs a normal insert cannot reach. */
      const insertRaw = (row: {
        market?: string;
        slug?: string;
        state?: string;
        ever?: boolean;
        retiredAt?: string | null;
        version?: number;
      }) =>
        sql.query(
          `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state,
             ever_public, held_at, retired_at, version, created_at)
           VALUES ($1, $2, 'default', $3, $4, $5, $6, now(), $7::timestamptz, $8, now())`,
          [
            randomUUID(),
            row.market ?? code,
            row.slug ?? `raw-${randomUUID().slice(0, 8)}`,
            randomUUID(),
            row.state ?? 'held',
            row.ever ?? false,
            row.retiredAt ?? null,
            row.version ?? 1,
          ],
        );
      const slug = `shop-${randomUUID().slice(0, 8)}`;

      await insert(code, slug, sellerId);
      await expect(insert(code, slug, randomUUID())).rejects.toMatchObject({
        code: '23505',
        constraint: 'shop_slugs_market_id_slug_key',
      });
      await expect(insert(code, `${slug}x`, sellerId)).rejects.toMatchObject({
        code: '23505',
        constraint: 'shop_slugs_market_id_seller_id_held_key',
      });
      // The same slug in the other Market is another key.
      await insert(other, slug, randomUUID());
      for (const [bad, constraint] of [
        ['Has-Upper', 'shop_slugs_slug_check'],
        ['ab', 'shop_slugs_slug_check'],
        ['a--b', 'shop_slugs_slug_check'],
        ['-abc', 'shop_slugs_slug_check'],
        ['abc-', 'shop_slugs_slug_check'],
        ['ab_c', 'shop_slugs_slug_check'],
        ['a'.repeat(51), 'shop_slugs_slug_check'],
      ] as const) {
        await expect(insert(code, bad, randomUUID())).rejects.toMatchObject({ constraint });
      }
      // 3 and 50 characters are accepted.
      const short = randomUUID().slice(0, 3);
      await insert(code, short, randomUUID());
      // The application role cannot delete; the owner removes the row so a re-run cannot clash.
      await owner.query('DELETE FROM sellers.shop_slugs WHERE market_id = $1 AND slug = $2', [
        code,
        short,
      ]);
      await insert(code, `${'a'.repeat(42)}${randomUUID().slice(0, 8)}`, randomUUID());

      const raw: [Parameters<typeof insertRaw>[0], string][] = [
        [{ state: 'retired', ever: true, retiredAt: null }, 'shop_slugs_retired_at_check'],
        [{ state: 'held', retiredAt: new Date().toISOString() }, 'shop_slugs_retired_at_check'],
        [
          { state: 'retired', ever: true, retiredAt: '2000-01-01T00:00:00Z' },
          'shop_slugs_retired_at_check',
        ],
        [{ state: 'bogus', ever: true }, 'shop_slugs_state_check'],
        [{ version: 0 }, 'shop_slugs_version_check'],
        [{ market: 'au' }, 'shop_slugs_market_id_check'],
      ];
      for (const [row, constraint] of raw) {
        await expect(insertRaw(row)).rejects.toMatchObject({ code: '23514', constraint });
      }

      // Only a slug that was ever public can be retired.
      await expect(insert(code, `${slug}r`, randomUUID(), 'retired', false)).rejects.toMatchObject({
        constraint: 'shop_slugs_ever_public_check',
      });
      await insert(code, `${slug}r`, randomUUID(), 'retired', true);
      await expect(
        sql.query('DELETE FROM sellers.shop_slugs WHERE slug = $1', [slug]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql.query('UPDATE sellers.shop_slugs SET slug = $2 WHERE slug = $1', [slug, 'other']),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql.query(
          'UPDATE sellers.shop_slugs SET seller_id = $3 WHERE market_id = $1 AND slug = $2',
          [code, slug, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // The application retires the held slug through the granted columns; the seller may then
      // hold another one, and nobody may hold the retired one again.
      const retired = await sql.query(
        `UPDATE sellers.shop_slugs SET state = 'retired', retired_at = now(), ever_public = true,
                version = version + 1
          WHERE market_id = $1 AND slug = $2 AND state = 'held'`,
        [code, slug],
      );
      expect(retired.rowCount).toBe(1);
      const next = `${slug}n`;
      await insert(code, next, sellerId);
      await expect(insert(code, slug, randomUUID())).rejects.toMatchObject({
        code: '23505',
        constraint: 'shop_slugs_market_id_slug_key',
      });
      // One held slug per seller and Market: the same seller id holds one in the other Market.
      await insert(other, `${slug}m`, sellerId);

      // One-way columns (Hassan L1): ever_public is never set back, a retired slug never returns.
      await sql.query(
        'UPDATE sellers.shop_slugs SET ever_public = true WHERE market_id = $1 AND slug = $2',
        [code, next],
      );
      await expect(
        sql.query(
          'UPDATE sellers.shop_slugs SET ever_public = false WHERE market_id = $1 AND slug = $2',
          [code, next],
        ),
      ).rejects.toMatchObject({ code: '23001' });
      await expect(
        sql.query(
          `UPDATE sellers.shop_slugs SET state = 'held', retired_at = NULL
            WHERE market_id = $1 AND slug = $2`,
          [code, slug],
        ),
      ).rejects.toMatchObject({ code: '23001' });

      const collation = await owner.query(
        `SELECT a.attname, c.collname FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_collation c ON c.oid = a.attcollation
          WHERE n.nspname = 'sellers' AND ((t.relname = 'shop_slugs' AND a.attname = 'slug')
             OR (t.relname = 'seller_files' AND a.attname = 'store_name_key'))
          ORDER BY a.attname`,
      );
      expect(collation.rows.map((row: { collname: string }) => row.collname)).toEqual(['C', 'C']);
    });

    it('counts in rate_counters with the closed kind list, a 32-byte key and a guarded decrement', async () => {
      const key = Buffer.alloc(32, 7);
      const reserve = (
        kind: string,
        hash: Buffer = key,
        marketCode: string = code,
        tenant = 'default',
      ) =>
        sql.query<{ count: number; window_started_at: string }>(
          `INSERT INTO sellers.rate_counters (market_id, tenant_id, kind, key_hash, window_started_at, count)
           VALUES ($1, $4, $2, $3, now(), 1)
           ON CONFLICT (market_id, kind, key_hash) DO UPDATE SET count = sellers.rate_counters.count + 1
           RETURNING count, window_started_at::text`,
          [marketCode, kind, hash, tenant],
        );
      const kinds = [
        'slug-check.account.minute',
        'slug-check.account.day',
        'save.account.minute',
        'save.account.day',
        'lookup.account',
        'lookup.origin',
        'lookup.market',
        'lookup.admin',
        'submit.file',
        'withdraw.file',
        'bulk.admin',
        'reviewer-notice.seller',
        'reviewer-notice.market',
      ];
      try {
        for (const kind of kinds) expect((await reserve(kind)).rows[0]!.count).toBe(1);
        expect((await reserve('save.account.day')).rows[0]!.count).toBe(2);
        // The same kind and key in the other Market is another row.
        expect((await reserve('save.account.day', key, other)).rows[0]!.count).toBe(1);
        await expect(reserve('unknown.kind')).rejects.toMatchObject({
          constraint: 'rate_counters_kind_check',
        });
        await expect(reserve('save.account.day', Buffer.alloc(31))).rejects.toMatchObject({
          constraint: 'rate_counters_key_hash_check',
        });
        await expect(reserve('save.account.day', Buffer.alloc(33))).rejects.toMatchObject({
          constraint: 'rate_counters_key_hash_check',
        });
        await expect(reserve('save.account.day', key, 'au')).rejects.toMatchObject({
          constraint: 'rate_counters_market_id_check',
        });
        await expect(reserve('save.account.day', key, code, 'Default')).rejects.toMatchObject({
          constraint: 'rate_counters_tenant_id_check',
        });

        // The release of a reviewer-notice reservation (3.11): only in the window the
        // reservation returned, and never below zero.
        const reserved = await reserve('reviewer-notice.seller');
        expect(reserved.rows[0]!.count).toBe(2);
        // As text: a JS Date would drop the microseconds of the stored instant.
        const window = reserved.rows[0]!.window_started_at;
        const release = (windowStartedAt: string, shiftSeconds = 0) =>
          sql.query(
            `UPDATE sellers.rate_counters SET count = count - 1
              WHERE market_id = $1 AND kind = 'reviewer-notice.seller' AND key_hash = $2
                AND window_started_at = $3::timestamptz - make_interval(secs => $4)
                AND count > 0`,
            [code, key, windowStartedAt, shiftSeconds],
          );
        // A stale window (the window restarted since the reservation) is never touched.
        expect((await release(window, 1)).rowCount).toBe(0);
        expect((await release(window)).rowCount).toBe(1);
        expect((await release(window)).rowCount).toBe(1);
        expect((await release(window)).rowCount).toBe(0);
        await expect(
          sql.query(
            `UPDATE sellers.rate_counters SET count = -1
              WHERE market_id = $1 AND kind = 'submit.file' AND key_hash = $2`,
            [code, key],
          ),
        ).rejects.toMatchObject({ constraint: 'rate_counters_count_check' });
      } finally {
        await sql.query(
          'DELETE FROM sellers.rate_counters WHERE market_id IN ($1, $2) AND key_hash = $3',
          [code, other, key],
        );
      }
    });
  });

  // Slice 2 part c-1 (sellers design 3.1, 3.5, 4.2, 4.3, 6.2, 6.5, 8.1; data design 3.1, 3.5,
  // 3.11, 4): the draft use cases on PostgreSQL with the real subject keys and identity.
  describe('slice 2 draft use cases', () => {
    const ids = new SequenceIdGenerator(clock);
    const FIXTURE = {
      AU: {
        address: { line1: '1 George St', suburb: 'Brisbane', state: 'QLD', postcode: '4000' },
        area: 'greater-brisbane',
        zones: ['Australia/Brisbane', 'Australia/Lindeman'],
      },
      ZZ: {
        address: { street: '1 Main', district: 'Central', prefecture: 'ZB', postalCode: '1000001' },
        area: 'zz-central',
        zones: ['Pacific/Auckland', 'Pacific/Chatham'],
      },
    }[code];
    const GENERAL = {
      storeName: 'Al Noor Grocer',
      businessName: 'Al Noor Trading Pty Ltd',
      phone: '+61 7 3000 0000',
      contactEmail: 'shop.canary@example.com',
    };

    /** Sets identity's access state directly (as the migration role): it must not freeze the draft. */
    const setAccessState = (sellerId: string, state: string) =>
      owner.query(
        `UPDATE identity.seller_access SET state = $2 WHERE market_id = $1 AND seller_id = $3`,
        [code, state, sellerId],
      );

    /** A registered seller (AU: `pending`; ZZ: `approved` at registration) and its owner's context. */
    async function draftSeller(): Promise<{ sellerId: Id<'Seller'>; context: CallContext }> {
      const sellerId = await registerSeller(code);
      return { sellerId, context: await ownerContext(code, sellerId) };
    }

    async function ownerContext(marketCode: string, sellerId: string): Promise<CallContext> {
      const { rows } = await sql.query<{ account_id: string }>(
        `SELECT account_id FROM identity.seller_memberships WHERE seller_id = $1`,
        [sellerId],
      );
      const market = marketOf(marketCode);
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: rows[0]!.account_id as Id<'Account'>,
          sessionId: ids.next<'Session'>(),
          sellerId: sellerId as Id<'Seller'>,
        }),
        `db-sellers-${randomUUID()}`,
      );
    }

    const row = async (sellerId: string) =>
      (
        await sql.query<Record<string, unknown>>(
          `SELECT store_name, store_name_key, business_name_ciphertext, phone_ciphertext,
                  contact_email_ciphertext, address_ciphertext, registered_address_ciphertext,
                  service_area_code, operating_timezone, timezone_source, address_timezone,
                  draft_complete, version
             FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2`,
          [code, sellerId],
        )
      ).rows[0]!;

    it('saves the draft encrypted at rest under the seller`s key and reads it back', async () => {
      const { sellerId, context } = await draftSeller();

      expect(await app.get(MyFileSaveGeneral).execute(context, GENERAL)).toEqual({
        ok: true,
        value: { version: 2, draftComplete: false, missing: ['address', 'timezone'] },
      });
      const saved = await app.get(MyFileSaveAddress).execute(context, {
        address: FIXTURE.address,
        timezone: FIXTURE.zones[1],
      });
      expect(saved.ok && saved.value.draftComplete).toBe(true);

      const stored = await row(sellerId);
      expect(stored).toMatchObject({
        store_name: 'Al Noor Grocer',
        store_name_key: 'al noor grocer',
        registered_address_ciphertext: null,
        service_area_code: FIXTURE.area,
        operating_timezone: FIXTURE.zones[1],
        timezone_source: 'seller',
        address_timezone: FIXTURE.zones[0],
        draft_complete: true,
        version: 3,
      });
      const clear = [
        GENERAL.businessName,
        '+61730000000',
        GENERAL.contactEmail,
        ...(Object.values(FIXTURE.address) as string[]),
      ];
      for (const column of [
        'business_name_ciphertext',
        'phone_ciphertext',
        'contact_email_ciphertext',
        'address_ciphertext',
      ]) {
        const value = stored[column] as string;
        expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
        for (const text of clear) expect(value).not.toContain(text);
      }

      const read = await app.get(MyFileRead).execute(context, {});
      expect(read.ok && read.value.general).toEqual({
        storeName: 'Al Noor Grocer',
        businessName: GENERAL.businessName,
        phone: '+61730000000',
        contactEmail: GENERAL.contactEmail,
      });
      expect(read.ok && read.value.address).toEqual(FIXTURE.address);
      expect(read.ok && read.value.zoneOptions).toEqual(FIXTURE.zones);

      // Bound to its label: a value copied into another column does not decrypt.
      await owner.query(
        `UPDATE sellers.seller_files SET phone_ciphertext = business_name_ciphertext
          WHERE market_id = $1 AND seller_id = $2`,
        [code, sellerId],
      );
      expect(await app.get(MyFileRead).execute(context, {})).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });
    });

    it('keeps sellers and Markets apart: ownership from the actor, ciphertext bound to its seller', async () => {
      const a = await draftSeller();
      const b = await draftSeller();
      await app.get(MyFileSaveGeneral).execute(a.context, GENERAL);
      await app
        .get(MyFileSaveGeneral)
        .execute(b.context, { ...GENERAL, businessName: 'Other Business Ltd' });
      const readB = await app.get(MyFileRead).execute(b.context, {});
      expect(readB.ok && readB.value.general.businessName).toBe('Other Business Ltd');

      // A's ciphertext copied into B's row does not open under B's key.
      await owner.query(
        `UPDATE sellers.seller_files SET business_name_ciphertext =
           (SELECT business_name_ciphertext FROM sellers.seller_files WHERE seller_id = $2)
          WHERE market_id = $1 AND seller_id = $3`,
        [code, a.sellerId, b.sellerId],
      );
      expect(await app.get(MyFileRead).execute(b.context, {})).toEqual({
        ok: false,
        error: { code: 'sellers.unavailable' },
      });

      // An actor of the other Market carrying A's seller id finds nothing and changes nothing.
      const elsewhere = await ownerContext(other, a.sellerId);
      expect(await app.get(MyFileRead).execute(elsewhere, {})).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      expect(await app.get(MyFileSaveGeneral).execute(elsewhere, GENERAL)).toEqual({
        ok: false,
        error: { code: 'file.not-found' },
      });
      expect((await row(a.sellerId)).version).toBe(2);
    });

    it('lets a seller complete the draft whatever identity reports: no approved revision, no freeze', async () => {
      const { sellerId, context } = await draftSeller();
      // ZZ approves at registration (approvalRequired false): `file-check-needed` (D 3.3), and
      // the details must still be completable. AU starts pending.
      const { rows } = await sql.query<{ state: string }>(
        'SELECT state FROM identity.seller_access WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId],
      );
      expect(rows[0]!.state).toBe(approvalRequired(code) ? 'pending' : 'approved');
      expect((await app.get(MyFileSaveGeneral).execute(context, GENERAL)).ok).toBe(true);
      expect(
        (await app.get(MyFileSaveAddress).execute(context, { address: FIXTURE.address })).ok,
      ).toBe(true);
      expect((await app.get(MyFileCheckSlug).execute(context, { slug: 'al-noor' })).ok).toBe(true);
      expect(await row(sellerId)).toMatchObject({ draft_complete: true, version: 3 });

      // `suspended` and `approved` do not freeze the draft by themselves either. (A suspended
      // seller has no session in identity; the draft rule is the file's alone.)
      for (const state of ['approved', 'suspended']) {
        await setAccessState(sellerId, state);
        expect((await app.get(MyFileSaveGeneral).execute(context, GENERAL)).ok).toBe(true);
      }
      expect((await row(sellerId)).version).toBe(5);
    });

    it('writes only over the version it read: concurrent saves never lose an update', async () => {
      const { sellerId, context } = await draftSeller();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          app
            .get(MyFileSaveGeneral)
            .execute(context, { ...GENERAL, businessName: `Business ${index}` }),
        ),
      );
      const saved = results.filter((result) => result.ok).length;
      expect(saved).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (!result.ok) expect(result.error).toEqual({ code: 'conflict.stale' });
      }
      expect((await row(sellerId)).version).toBe(1 + saved);
    });

    it('answers slug availability from shop_slugs, and limits checks to 30 a minute', async () => {
      const { sellerId, context } = await draftSeller();
      const suffix = randomUUID().slice(0, 8);
      const insert = (slug: string, seller: string, state: 'held' | 'retired') =>
        sql.query(
          `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state,
             ever_public, held_at, retired_at, version, created_at)
           VALUES ($1, $2, 'default', $3, $4, $5, $6, now(),
                   CASE WHEN $5 = 'retired' THEN now() END, 1, now())`,
          [randomUUID(), code, slug, seller, state, state === 'retired'],
        );
      await insert(`taken-${suffix}`, randomUUID(), 'held');
      await insert(`mine-${suffix}`, sellerId, 'held');
      await insert(`gone-${suffix}`, sellerId, 'retired');
      const check = (slug: string) => app.get(MyFileCheckSlug).execute(context, { slug });

      expect(await check(`Free-${suffix}`)).toEqual({
        ok: true,
        value: { code: 'slug.available', slug: `free-${suffix}` },
      });
      expect(await check(`taken-${suffix}`)).toEqual({ ok: true, value: { code: 'slug.taken' } });
      expect(await check(`mine-${suffix}`)).toEqual({
        ok: true,
        value: { code: 'slug.available', slug: `mine-${suffix}` },
      });
      expect(await check(`gone-${suffix}`)).toEqual({ ok: true, value: { code: 'slug.taken' } });
      expect(await check('admin')).toEqual({ ok: true, value: { code: 'slug.reserved' } });
      expect(await check('a--b')).toEqual({ ok: true, value: { code: 'slug.format' } });
      for (let attempt = 6; attempt < 30; attempt += 1) {
        expect((await check(`free-${suffix}`)).ok).toBe(true);
      }
      expect(await check(`free-${suffix}`)).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 60 },
      });

      // Two counters for this account, keyed by an HMAC (no id in clear), the minute one at 31.
      const { rows } = await sql.query<{ kind: string; count: number; bytes: number }>(
        `SELECT kind, count, octet_length(key_hash) AS bytes FROM sellers.rate_counters
          WHERE market_id = $1 AND kind LIKE 'slug-check.%' AND count >= 31 ORDER BY kind`,
        [code],
      );
      expect(rows).toEqual([
        { kind: 'slug-check.account.day', count: 31, bytes: 32 },
        { kind: 'slug-check.account.minute', count: 31, bytes: 32 },
      ]);
      const { rows: leaked } = await sql.query(
        `SELECT 1 FROM sellers.rate_counters
          WHERE position(convert_to($1, 'UTF8') IN key_hash) > 0`,
        [(context.actor as { accountId: string }).accountId],
      );
      expect(leaked).toEqual([]);
    });

    it('fails closed with access.unavailable when the counter store errors', async () => {
      const { sellerId, context } = await draftSeller();
      // A constraint no counter row can meet makes every reservation fail in the database.
      await owner.query(
        `ALTER TABLE sellers.rate_counters
           ADD CONSTRAINT rate_counters_test_refuse CHECK (count < 0) NOT VALID`,
      );
      try {
        expect(await app.get(MyFileSaveGeneral).execute(context, GENERAL)).toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
        expect(await app.get(MyFileCheckSlug).execute(context, { slug: 'al-noor' })).toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
      } finally {
        await owner.query(
          'ALTER TABLE sellers.rate_counters DROP CONSTRAINT rate_counters_test_refuse',
        );
      }
      expect((await row(sellerId)).version).toBe(1);
    });
  });
});
