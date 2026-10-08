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
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SELLERS_FACADE, type SellersFacade } from '../../src/modules/sellers';
import { BackfillSellerFiles } from '../../src/modules/sellers/application/use-cases/backfill-seller-files.use-case';
import { MyFileValidateIdentifier } from '../../src/modules/sellers/application/use-cases/my-file-validate-identifier.use-case';
import { MyFileSaveIdentifier } from '../../src/modules/sellers/application/use-cases/my-file-save-identifier.use-case';
import { MyFileSaveSlug } from '../../src/modules/sellers/application/use-cases/my-file-save-slug.use-case';
import { MyFileCheckSlug } from '../../src/modules/sellers/application/use-cases/my-file-check-slug.use-case';
import { MyFileRead } from '../../src/modules/sellers/application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from '../../src/modules/sellers/application/use-cases/my-file-save-address.use-case';
import { MyFileSaveGeneral } from '../../src/modules/sellers/application/use-cases/my-file-save-general.use-case';
import {
  IDENTIFIER_INDEX,
  type IdentifierIndex,
} from '../../src/modules/sellers/application/ports/identifier-index';
import {
  TAX_PROFILE_REPOSITORY,
  type TaxProfileRepository,
} from '../../src/modules/sellers/application/ports/tax-profile.repository';
import type { NormalisedIdentifier } from '../../src/modules/sellers/domain/business-identifier';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { PrismaShopSlugRepository } from '../../src/modules/sellers/infrastructure/prisma-shop-slug.repository';
import { reservedWordsOf } from '../../src/modules/sellers/domain/reserved-words';
import { parseShopSlug } from '../../src/modules/sellers/domain/shop-slug';
import { PrismaRateCounterRepository } from '../../src/modules/sellers/infrastructure/prisma-rate-counter.repository';
import {
  RATE_COUNTER_KINDS,
  SAVE_LIMITS,
  rateVerdict,
} from '../../src/modules/sellers/domain/rate-limits';
import type { RateCounter } from '../../src/modules/sellers/application/ports/rate-counter.repository';
import { BUSINESS_REGISTER_LOOKUPS } from '../../src/modules/sellers/application/ports/business-register-lookup';
import { REGISTER_LOOKUP_POLICY } from '../../src/modules/sellers/application/ports/register-lookup-policy';
import { ReviewRegisterCheckRead } from '../../src/modules/sellers/application/use-cases/review-register-check-read.use-case';
import { identifierIndexKeyOf } from '../../src/modules/sellers/domain/business-identifier';
import { abnScheme } from '../../src/modules/sellers/infrastructure/identifier-schemes/abn';
import { zzCorpNoScheme } from '../../src/modules/sellers/infrastructure/identifier-schemes/zz-corp-no';
import { PrismaRegisterCheckRepository } from '../../src/modules/sellers/infrastructure/prisma-register-check.repository';
import { MarketConfigRegisterLookups } from '../../src/modules/sellers/infrastructure/register-lookups';
import {
  FAKE_REGISTER_ADAPTER,
  FakeRegisterLookup,
} from '../../src/modules/sellers/infrastructure/register-lookups/fake';
import { FixedRegisterLookupPolicy, validIdentifiers } from '../support/sellers-register-fakes';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { ok } from '@mondapac/shared-kernel';
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
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { sellerFilesOwnerTestDatabaseUrl, sellerFilesTestDatabaseUrl } from './test-database';

// Sellers slice 1 on PostgreSQL (sellers design 7.1, 7.5, 14.3 Q-M4; data design 3.1, 3.7 to
// 3.9, 3.12, 8), for both Market fixtures: a seller registers through the real identity flow, the
// relay and the dispatcher run `sellers.create-file`, and the file with its three roots, the
// event and the inbox row are read back as the application role. The backfill, `sellerSummaries`
// and the constraints are checked on the same rows. This file runs on its own copy of the run
// database (global-setup.ts): the relay and the dispatcher claim every due row of a Market.

const NO_WORDS = reservedWordsOf({ slugs: [], claimWords: [] });
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
 * Isolates the sellers use cases from identity's gate, so that this file exercises sellers' own
 * ownership and state logic, including for actors the real gate refuses first (a session of
 * another Market, a suspended seller). It admits an authenticated seller actor under a
 * `permissions` rule and nothing else. Since identity slice 8a-1 the real check admits the
 * Seller Owner under every seller key; that path is covered by test/db/role-seed.db-spec.ts and
 * the end-to-end tests of the sellers routes.
 */
const sellerOwnerCheck: AuthorisationCheck = {
  check: (context, declaration) =>
    Promise.resolve(
      context.actor.kind === 'authenticated' &&
        // An admin is admitted under a permission rule as well: the reviewer's read of slice 4a
        // (its real gate rule is checked by the use-case gate suites and the role seed).
        ((context.actor.population === 'seller' && context.actor.sellerId !== null) ||
          context.actor.population === 'admin') &&
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
  // The register lookup of slice 4a: no Market has a register until a test gives it one.
  const registerPolicy = new FixedRegisterLookupPolicy();
  let fakeRegister: FakeRegisterLookup;

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
    fakeRegister = new FakeRegisterLookup();
    registerPolicy.set(code, { kind: 'none' });
    clock.advance(Temporal.Duration.from({ hours: 25 }));
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    ({ app } = await createTestApp({
      env: { DATABASE_URL: sellerFilesTestDatabaseUrl() },
      // Seller routes need the seller panel's origin on the list (identity design 6.4).
      panelOrigins: true,
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(MAIL_TRANSPORT)
          .useValue(transport)
          .overrideProvider(AUTHORISATION_CHECK)
          .useValue(sellerOwnerCheck)
          .overrideProvider(REGISTER_LOOKUP_POLICY)
          .useValue(registerPolicy)
          .overrideProvider(BUSINESS_REGISTER_LOOKUPS)
          .useValue(
            new MarketConfigRegisterLookups(
              registerPolicy,
              new Map([[FAKE_REGISTER_ADAPTER, fakeRegister]]),
            ),
          ),
    }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    await app.get(SeedRoles).execute(systemContext(market.marketId), {});
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

  /**
   * Signs a seller up and confirms the email in `marketCode`; answers the seller id and the
   * headers of the session it opened (cookie and CSRF token).
   */
  async function signUpSeller(
    marketCode: string,
  ): Promise<{ sellerId: Id<'Seller'>; headers: Record<string, string> }> {
    const email = `Seller.Owner+${randomUUID()}@Example.com`;
    const post = (path: string, body: object) =>
      request(app.getHttpServer())
        .post(`/identity/seller/${path}`)
        .set({ 'x-market-id': marketCode, ...panelHeaders(marketCode, 'seller') })
        .send(body);
    const signedUp = await post('sign-up', {
      displayName: 'Amina Rahman',
      email,
      password: PASSWORD,
    });
    expect(signedUp.status).toBe(202);
    await settle();
    const mail = transport.sent.filter((message) => message.to === email)[0]!;
    const confirmed = await post('confirm-email', { token: tokenOf(mail), password: PASSWORD });
    expect(confirmed.status).toBe(200);
    await settle();
    const { rows } = await sql.query<{ seller_id: string }>(
      `SELECT m.seller_id FROM identity.seller_memberships m
         JOIN identity.accounts a ON a.market_id = m.market_id AND a.id = m.account_id
        WHERE a.market_id = $1 AND a.email_normalized = $2`,
      [marketCode, email.toLowerCase()],
    );
    const [cookie] = (confirmed.headers['set-cookie'] as unknown as string[])[0]!.split(';', 1);
    return {
      sellerId: rows[0]!.seller_id as Id<'Seller'>,
      headers: {
        'x-market-id': marketCode,
        ...panelHeaders(marketCode, 'seller'),
        cookie: cookie!,
        'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
      },
    };
  }

  const registerSeller = async (marketCode: string): Promise<Id<'Seller'>> =>
    (await signUpSeller(marketCode)).sellerId;

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
    await app.get(SeedRoles).execute(systemContext(other), {});
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

    const draftSlugOf = async (sellerId: string) =>
      (
        await sql.query<{ draft_slug: string | null }>(
          'SELECT draft_slug FROM sellers.seller_files WHERE seller_id = $1',
          [sellerId],
        )
      ).rows[0]!.draft_slug;

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

    it('holds a draft slug of the shop_slugs rule, with no unique key (Q-M25)', async () => {
      const first = await registerSeller(code);
      const second = await registerSeller(code);
      const accepted = ['abc', 'a-b-c', 'a1-2b', 'a'.repeat(50)];
      for (const value of accepted) {
        await update(first, 'draft_slug = $2', [value]);
        expect(await draftSlugOf(first)).toBe(value);
      }
      for (const value of [
        'ab',
        'a'.repeat(51),
        'Abc',
        '-abc',
        'abc-',
        'a--b',
        'ab c',
        '\u0430bc',
        'caf\u00e9',
        'abc\n',
      ]) {
        await refuses(
          'UPDATE sellers.seller_files SET draft_slug = $2 WHERE seller_id = $1',
          [first, value],
          'seller_files_draft_slug_check',
        );
      }
      // Not unique: two files may hold the same draft slug (uniqueness is decided in shop_slugs).
      await update(first, 'draft_slug = $2', ['same-shop']);
      await update(second, 'draft_slug = $2', ['same-shop']);
      expect(await draftSlugOf(second)).toBe('same-shop');
      await update(first, 'draft_slug = NULL');
      expect(await draftSlugOf(first)).toBeNull();
      const indexes = await owner.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'sellers' AND tablename = 'seller_files'
            AND indexdef LIKE '%draft_slug%'`,
      );
      expect(indexes.rows).toEqual([]);
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
      // Since slice 5 (Q-M21) the application may delete a row: a never-public held slug is
      // released before approval. Which rows is the application's rule (data design 22, open
      // point 1); the grant itself is checked on a row of its own.
      const released = `${slug}d`;
      await insert(code, released, randomUUID());
      expect(
        (
          await sql.query('DELETE FROM sellers.shop_slugs WHERE market_id = $1 AND slug = $2', [
            code,
            released,
          ])
        ).rowCount,
      ).toBe(1);
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
             OR (t.relname = 'seller_files' AND a.attname IN ('store_name_key', 'draft_slug')))
          ORDER BY a.attname`,
      );
      expect(collation.rows.map((row: { collname: string }) => row.collname)).toEqual([
        'C',
        'C',
        'C',
      ]);
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

  describe('PrismaRateCounterRepository (real counters, injected now)', () => {
    const T0 = Temporal.Instant.from('2026-10-08T12:00:00Z');
    const keys: Buffer[] = [];
    const newKey = (): Buffer => {
      const key = Buffer.from(
        randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        'hex',
      );
      keys.push(key);
      return key;
    };
    afterEach(async () => {
      if (keys.length === 0) return;
      await sql.query('DELETE FROM sellers.rate_counters WHERE key_hash = ANY($1::bytea[])', [
        keys,
      ]);
      keys.length = 0;
    });

    const reserve = (
      marketCode: string,
      limits: typeof SAVE_LIMITS,
      key: Buffer,
      now: Temporal.Instant,
    ) => {
      const counters: RateCounter[] = limits.map((limit) => ({ limit, keyHash: key }));
      const marketContext = marketOf(marketCode);
      return app
        .get<UnitOfWork>(UNIT_OF_WORK)
        .run(marketContext, async () =>
          ok(
            await new PrismaRateCounterRepository(app.get(PrismaService)).reserve(
              marketContext,
              counters,
              now,
            ),
          ),
        )
        .then((result) => {
          if (!result.ok) throw new Error('the reservation unit failed');
          return result.value;
        });
    };
    const count = (reservations: Awaited<ReturnType<typeof reserve>>, kind: string) =>
      reservations.find((reservation) => reservation.kind === kind)!.count;

    it('refuses over the limit, restarts the window, and keeps minute and day apart', async () => {
      expect(RATE_COUNTER_KINDS).toContain('save.account.minute');
      const key = newKey();
      let last = await reserve(code, SAVE_LIMITS, key, T0);
      for (let attempt = 2; attempt <= 60; attempt += 1) {
        last = await reserve(code, SAVE_LIMITS, key, T0);
        expect(rateVerdict(SAVE_LIMITS, last, T0)).toEqual({ allowed: true });
      }
      expect(count(last, 'save.account.minute')).toBe(60);
      const refused = await reserve(code, SAVE_LIMITS, key, T0);
      expect(count(refused, 'save.account.minute')).toBe(61);
      expect(rateVerdict(SAVE_LIMITS, refused, T0)).toEqual({
        allowed: false,
        retryAfterSeconds: 60,
      });

      // One window later the minute counter restarts at 1; the day counter keeps counting.
      const later = T0.add({ minutes: 1 });
      const restarted = await reserve(code, SAVE_LIMITS, key, later);
      expect(count(restarted, 'save.account.minute')).toBe(1);
      expect(count(restarted, 'save.account.day')).toBe(62);
      expect(rateVerdict(SAVE_LIMITS, restarted, later)).toEqual({ allowed: true });

      // A day later both restart.
      const nextDay = T0.add({ hours: 24 });
      const fresh = await reserve(code, SAVE_LIMITS, key, nextDay);
      expect(count(fresh, 'save.account.minute')).toBe(1);
      expect(count(fresh, 'save.account.day')).toBe(1);
    });

    it('counts every one of N parallel reservations exactly once', async () => {
      const key = newKey();
      const n = 12;
      const results = await Promise.all(
        Array.from({ length: n }, () => reserve(code, SAVE_LIMITS, key, T0)),
      );
      expect(
        results.map((result) => count(result, 'save.account.minute')).sort((a, b) => a - b),
      ).toEqual(Array.from({ length: n }, (_, index) => index + 1));
      const { rows } = await sql.query<{ kind: string; count: number }>(
        'SELECT kind, count FROM sellers.rate_counters WHERE market_id = $1 AND key_hash = $2 ORDER BY kind',
        [code, key],
      );
      expect(rows).toEqual([
        { kind: 'save.account.day', count: n },
        { kind: 'save.account.minute', count: n },
      ]);
    });

    it('purges counters whose window started before the cut-off, in this Market only', async () => {
      const old = newKey();
      const kept = newKey();
      const edge = newKey();
      const elsewhere = newKey();
      await reserve(code, SAVE_LIMITS, edge, T0.subtract({ hours: 48 }));
      await reserve(code, SAVE_LIMITS, old, T0.subtract({ hours: 49 }));
      await reserve(code, SAVE_LIMITS, kept, T0.subtract({ hours: 47 }));
      await reserve(other, SAVE_LIMITS, elsewhere, T0.subtract({ hours: 49 }));
      const purge = async (marketCode: string) => {
        const marketContext = marketOf(marketCode);
        const result = await app
          .get<UnitOfWork>(UNIT_OF_WORK)
          .run(marketContext, async () =>
            ok(
              await new PrismaRateCounterRepository(app.get(PrismaService)).purgeStartedBefore(
                marketContext,
                T0.subtract({ hours: 48 }),
              ),
            ),
          );
        if (!result.ok) throw new Error('the purge unit failed');
        return result.value;
      };
      const remaining = async (key: Buffer, marketCode: string) =>
        (
          await sql.query(
            'SELECT 1 FROM sellers.rate_counters WHERE market_id = $1 AND key_hash = $2',
            [marketCode, key],
          )
        ).rowCount;

      // Other tests may leave rows of their own; only the three keys of this test are asserted.
      expect(await purge(code)).toBeGreaterThanOrEqual(2);
      expect(await remaining(old, code)).toBe(0);
      expect(await remaining(kept, code)).toBe(2);
      // Exactly 48 hours old is not before the cut-off: kept.
      expect(await remaining(edge, code)).toBe(2);
      expect(await remaining(elsewhere, other)).toBe(2);
      expect(await purge(code)).toBe(0);
      expect(await purge(other)).toBeGreaterThanOrEqual(2);
      expect(await remaining(elsewhere, other)).toBe(0);
    });

    it('does not throttle another account, nor the same account in another Market', async () => {
      const a = newKey();
      const b = newKey();
      for (let attempt = 0; attempt < 61; attempt += 1) await reserve(code, SAVE_LIMITS, a, T0);
      const atLimit = await reserve(code, SAVE_LIMITS, a, T0);
      expect(rateVerdict(SAVE_LIMITS, atLimit, T0).allowed).toBe(false);

      const otherAccount = await reserve(code, SAVE_LIMITS, b, T0);
      expect(count(otherAccount, 'save.account.minute')).toBe(1);
      expect(rateVerdict(SAVE_LIMITS, otherAccount, T0)).toEqual({ allowed: true });

      const otherMarket = await reserve(other, SAVE_LIMITS, a, T0);
      expect(count(otherMarket, 'save.account.minute')).toBe(1);
      expect(rateVerdict(SAVE_LIMITS, otherMarket, T0)).toEqual({ allowed: true });
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
    /** The missing parts as this Market sees them: the identifier only where it is required. */
    const parts = (...list: string[]) =>
      list.filter(
        (part) =>
          part !== 'identifier' ||
          (app.get(MarketRegistry).get(marketOf(code).marketId).sellers?.businessIdentifier
            .required ??
            true),
      );
    /** A valid number of the Market's scheme (the checksums differ per scheme). */
    const IDENTIFIER = {
      AU: { typed: '51 824 753 556', normalised: '51824753556', display: '51 824 753 556' },
      ZZ: { typed: '123-456-782', normalised: '123456782', display: '123-456-782' },
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
                  draft_complete, draft_slug, version
             FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2`,
          [code, sellerId],
        )
      ).rows[0]!;

    it('gives sellerSummaries the draft zone to the system caller only, never across Markets', async () => {
      const { sellerId, context } = await draftSeller();
      const none = await facade().sellerSummaries(systemContext(code), [sellerId]);
      expect(none).toEqual({ ok: true, value: [{ sellerId, exists: true }] });

      await app.get(MyFileSaveGeneral).execute(context, GENERAL);
      await app.get(MyFileSaveAddress).execute(context, { address: FIXTURE.address });

      const asSystem = await facade().sellerSummaries(systemContext(code), [sellerId]);
      const asRequest = await facade().sellerSummaries(anonymousContext(code), [sellerId]);
      const elsewhere = await facade().sellerSummaries(systemContext(other), [sellerId]);
      expect(asSystem).toEqual({
        ok: true,
        value: [
          {
            sellerId,
            exists: true,
            operatingTimezone: { zone: FIXTURE.zones[0], provisional: true },
          },
        ],
      });
      expect(asRequest).toEqual({ ok: true, value: [{ sellerId, exists: true }] });
      expect(elsewhere).toEqual({ ok: true, value: [{ sellerId, exists: false }] });
    });

    it('saves the draft encrypted at rest under the seller`s key and reads it back', async () => {
      const { sellerId, context } = await draftSeller();

      expect(await app.get(MyFileSaveGeneral).execute(context, GENERAL)).toEqual({
        ok: true,
        value: {
          version: 2,
          draftComplete: false,
          missing: parts('address', 'timezone', 'identifier', 'slug'),
        },
      });
      const saved = await app.get(MyFileSaveAddress).execute(context, {
        address: FIXTURE.address,
        timezone: FIXTURE.zones[1],
      });
      expect(saved.ok && saved.value.missing).toEqual(parts('identifier', 'slug'));
      expect(saved.ok && saved.value.draftComplete).toBe(false);

      const stored = await row(sellerId);
      expect(stored).toMatchObject({
        store_name: 'Al Noor Grocer',
        store_name_key: 'al noor grocer',
        registered_address_ciphertext: null,
        service_area_code: FIXTURE.area,
        operating_timezone: FIXTURE.zones[1],
        timezone_source: 'seller',
        address_timezone: FIXTURE.zones[0],
        draft_complete: false,
        draft_slug: null,
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
        // Short values (a postcode, a region code) can appear in random ciphertext by chance.
        for (const text of clear.filter((t) => t.length >= 8)) expect(value).not.toContain(text);
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
      expect(
        (await app.get(MyFileSaveIdentifier).execute(context, { identifier: IDENTIFIER.typed })).ok,
      ).toBe(true);
      expect((await app.get(MyFileCheckSlug).execute(context, { slug: 'al-noor' })).ok).toBe(true);
      expect((await row(sellerId)).draft_slug).toBeNull();
      expect(
        (await app.get(MyFileSaveSlug).execute(context, { slug: `al-noor-${code.toLowerCase()}` }))
          .ok,
      ).toBe(true);
      expect(await row(sellerId)).toMatchObject({ draft_complete: true, version: 5 });

      // `suspended` and `approved` do not freeze the draft by themselves either. (A suspended
      // seller has no session in identity; the draft rule is the file's alone.)
      for (const state of ['approved', 'suspended']) {
        await setAccessState(sellerId, state);
        expect((await app.get(MyFileSaveGeneral).execute(context, GENERAL)).ok).toBe(true);
      }
      expect((await row(sellerId)).version).toBe(7);
    });

    it('proves only the read-to-write guard: a save writes over the version it read, a lost race is conflict.stale', async () => {
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

    it('saves the draft slug through the repository, round-trips it, and guards the version (Q-M25)', async () => {
      const { sellerId, context } = await draftSeller();
      const suffix = randomUUID().slice(0, 8);
      const save = (slug: string) => app.get(MyFileSaveSlug).execute(context, { slug });

      expect(await save(`Noor-${suffix}`)).toEqual({
        ok: true,
        value: {
          version: 2,
          draftComplete: false,
          missing: parts('storeName', 'businessName', 'phone', 'address', 'timezone', 'identifier'),
        },
      });
      expect(await row(sellerId)).toMatchObject({ draft_slug: `noor-${suffix}`, version: 2 });
      const read = await app.get(MyFileRead).execute(context, {});
      expect(read.ok && read.value.slug).toBe(`noor-${suffix}`);
      // The same slug again: no write, no new version.
      expect((await save(`noor-${suffix}`)).ok).toBe(true);
      expect((await row(sellerId)).version).toBe(2);
      // A general save keeps it.
      await app.get(MyFileSaveGeneral).execute(context, GENERAL);
      expect(await row(sellerId)).toMatchObject({ draft_slug: `noor-${suffix}`, version: 3 });

      // A write over a version that is no longer current changes no row.
      const stale = await sql.query(
        `UPDATE sellers.seller_files SET draft_slug = 'stale-write', version = 2
          WHERE market_id = $1 AND seller_id = $2 AND version = 1`,
        [code, sellerId],
      );
      expect(stale.rowCount).toBe(0);
      expect((await row(sellerId)).draft_slug).toBe(`noor-${suffix}`);

      // Reserved, malformed and taken slugs write nothing.
      await sql.query(
        `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state,
           ever_public, held_at, version, created_at)
         VALUES ($1, $2, 'default', $3, $4, 'held', false, now(), 1, now())`,
        [randomUUID(), code, `held-${suffix}`, randomUUID()],
      );
      expect(await save(`held-${suffix}`)).toEqual({ ok: false, error: { code: 'slug.taken' } });
      expect(await save('admin')).toEqual({ ok: false, error: { code: 'slug.reserved' } });
      expect(await save('a--b')).toEqual({ ok: false, error: { code: 'slug.format' } });
      expect(await row(sellerId)).toMatchObject({ draft_slug: `noor-${suffix}`, version: 3 });
    });

    it('saves nothing when another unit bumped the version after the file was loaded (deterministic stale)', async () => {
      const { sellerId } = await draftSeller();
      const marketContext = marketOf(code);
      const files = new PrismaSellerFileRepository(app.get(PrismaService));
      const slug = parseShopSlug(`stale-${randomUUID().slice(0, 8)}`, NO_WORDS);
      if (!slug.ok) throw new Error('the test slug is well formed');

      const saved = await app
        .get<UnitOfWork>(UNIT_OF_WORK)
        .run<boolean, never>(marketContext, async () => {
          const file = await files.findById(marketContext, sellerId);
          // Another unit commits a save after this one read the file.
          await sql.query(
            'UPDATE sellers.seller_files SET version = version + 1 WHERE seller_id = $1',
            [sellerId],
          );
          const applied = file!.saveSlug(slug.value, clock.now(), {
            identifierRequired: false,
            identifierScheme: 'abn',
          });
          if (!applied.ok) throw new Error('the slug is accepted by the aggregate');
          return ok(await files.saveDraft(marketContext, file!));
        });
      expect(saved).toEqual({ ok: true, value: false });
      expect(await row(sellerId)).toMatchObject({ draft_slug: null, version: 2 });
    });

    it("reads a retired slug, own or another seller's, as taken through the repository mapping", async () => {
      const { sellerId, context } = await draftSeller();
      const suffix = randomUUID().slice(0, 8);
      const slugs = new PrismaShopSlugRepository(app.get(PrismaService));
      const retire = (slug: string, seller: string) =>
        sql.query(
          `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state,
             ever_public, held_at, retired_at, version, created_at)
           VALUES ($1, $2, 'default', $3, $4, 'retired', true, now(), now(), 1, now())`,
          [randomUUID(), code, slug, seller],
        );
      await retire(`own-${suffix}`, sellerId);
      await retire(`other-${suffix}`, randomUUID());
      const marketContext = marketOf(code);
      const lookup = async (value: string) => {
        const parsed = parseShopSlug(value, NO_WORDS);
        if (!parsed.ok) throw new Error('the test slug is well formed');
        return app
          .get<UnitOfWork>(UNIT_OF_WORK)
          .run(marketContext, async () => ok(await slugs.findBySlug(marketContext, parsed.value)));
      };
      const own = await lookup(`own-${suffix}`);
      expect(own.ok && own.value).toMatchObject({ sellerId, state: 'retired' });
      const other = await lookup(`other-${suffix}`);
      expect(other.ok && other.value).toMatchObject({ state: 'retired' });

      expect(await app.get(MyFileCheckSlug).execute(context, { slug: `own-${suffix}` })).toEqual({
        ok: true,
        value: { code: 'slug.taken' },
      });
      expect(await app.get(MyFileSaveSlug).execute(context, { slug: `other-${suffix}` })).toEqual({
        ok: false,
        error: { code: 'slug.taken' },
      });
      expect(await app.get(MyFileSaveSlug).execute(context, { slug: `own-${suffix}` })).toEqual({
        ok: false,
        error: { code: 'slug.taken' },
      });
    });

    it('lets parallel slug saves have one winner per version, never a lost update', async () => {
      const { sellerId, context } = await draftSeller();
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          app.get(MyFileSaveSlug).execute(context, { slug: `race-${index}-${code.toLowerCase()}` }),
        ),
      );
      const saved = results.filter((result) => result.ok).length;
      expect(saved).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (!result.ok) expect(result.error).toEqual({ code: 'conflict.stale' });
      }
      const stored = await row(sellerId);
      expect(stored.version).toBe(1 + saved);
      expect(stored.draft_slug).toMatch(/^race-\d-/);
    });

    it('stores a seller zone choice, and a refused zone changes nothing', async () => {
      const { sellerId, context } = await draftSeller();
      const addressKey = Object.keys(FIXTURE.address)[0] as keyof typeof FIXTURE.address;
      const chosen = await app.get(MyFileSaveAddress).execute(context, {
        address: FIXTURE.address,
        timezone: FIXTURE.zones[1],
      });
      expect(chosen.ok && chosen.value.timezone).toMatchObject({
        operatingTimezone: FIXTURE.zones[1],
        timezoneSource: 'seller',
      });
      const before = await row(sellerId);
      expect(before).toMatchObject({
        operating_timezone: FIXTURE.zones[1],
        timezone_source: 'seller',
      });

      for (const timezone of ['Etc/UTC', '+10:00', '', 123]) {
        const refused = await app.get(MyFileSaveAddress).execute(context, {
          address: { ...FIXTURE.address, [addressKey]: 'Changed 99' },
          timezone,
        });
        expect(refused).toEqual({ ok: false, error: { code: 'timezone.not-selectable' } });
        const after = await row(sellerId);
        expect(after.version).toBe(before.version);
        expect(after.address_ciphertext).toBe(before.address_ciphertext);
        expect(after.operating_timezone).toBe(before.operating_timezone);
        expect(after.timezone_source).toBe(before.timezone_source);
        expect(after.address_timezone).toBe(before.address_timezone);
        expect(after).toEqual(before);
      }
    });

    it('keeps a single winner when general and address saves race', async () => {
      const { sellerId, context } = await draftSeller();
      const addressKey = Object.keys(FIXTURE.address)[0] as keyof typeof FIXTURE.address;
      const generals = Array.from({ length: 4 }, (_, index) => `Racing Business ${index}`);
      const addresses = Array.from({ length: 4 }, (_, index) => `${index + 1} Racing Rd`);
      const results = await Promise.all([
        ...generals.map((businessName) =>
          app.get(MyFileSaveGeneral).execute(context, { ...GENERAL, businessName }),
        ),
        ...addresses.map((line) =>
          app
            .get(MyFileSaveAddress)
            .execute(context, { address: { ...FIXTURE.address, [addressKey]: line } }),
        ),
      ]);
      const saved = results.filter((result) => result.ok).length;
      expect(saved).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (!result.ok) expect(result.error).toEqual({ code: 'conflict.stale' });
      }
      expect((await row(sellerId)).version).toBe(1 + saved);

      // Every sealed column opens (one coherent state), and each holds a value one saved call sent.
      const read = await app.get(MyFileRead).execute(context, {});
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const winnerName = read.value.general.businessName;
      expect(winnerName === null || generals.includes(winnerName)).toBe(true);
      const winnerAddress = read.value.address;
      expect(winnerAddress === null || addresses.includes(winnerAddress[addressKey] ?? '')).toBe(
        true,
      );
      // A value is present only if a call that sent it succeeded.
      const generalWins = results.slice(0, 4).filter((result) => result.ok).length;
      const addressWins = results.slice(4).filter((result) => result.ok).length;
      expect(winnerName === null).toBe(generalWins === 0);
      expect(winnerAddress === null).toBe(addressWins === 0);
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

    describe('slice 3: business identifier and tax registration periods', () => {
      const refuses = (statement: string, params: unknown[], constraint: string) =>
        expect(sql.query(statement, params)).rejects.toMatchObject({ code: '23514', constraint });
      const ciphertext = (length: number) => `v1.${'A'.repeat(length - 3)}`;
      const indexBytes = (n: number) => Buffer.alloc(32, n);
      const scheme = code === 'AU' ? 'abn' : 'zz-corp-no';
      // Ids from a clock of its own (2031, a day apart per Market): the run clocks restart for
      // each Market and would mint the same ids twice in this database.
      const uniqueIds = new SequenceIdGenerator(
        new FixedClock(
          Temporal.Instant.from('2031-01-01T00:00:00Z').add({ hours: code === 'AU' ? 0 : 24 }),
        ),
      );
      const foreign = code === 'AU' ? '123-456-782' : '51 824 753 556';
      const identifierRow = async (sellerId: string) =>
        (
          await sql.query<{
            identifier_scheme: string | null;
            identifier_ciphertext: string | null;
            identifier_index: Buffer | null;
            draft_complete: boolean;
            version: number;
          }>(
            `SELECT identifier_scheme, identifier_ciphertext, identifier_index, draft_complete, version
               FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2`,
            [code, sellerId],
          )
        ).rows[0]!;

      it('holds the three identifier columns together and refuses what their CHECKs refuse', async () => {
        const sellerId = await registerSeller(code);
        const set = (sets: string, params: unknown[] = []) =>
          sql.query(`UPDATE sellers.seller_files SET ${sets} WHERE seller_id = $1`, [
            sellerId,
            ...params,
          ]);
        await set('identifier_scheme = $2, identifier_ciphertext = $3, identifier_index = $4', [
          scheme,
          ciphertext(41),
          indexBytes(1),
        ]);
        // The bound of 512 and the minimum of 41 (data design 4.5).
        await set('identifier_ciphertext = $2', [ciphertext(512)]);
        await refuses(
          'UPDATE sellers.seller_files SET identifier_ciphertext = $2 WHERE seller_id = $1',
          [sellerId, ciphertext(513)],
          'seller_files_identifier_ciphertext_check',
        );
        await refuses(
          'UPDATE sellers.seller_files SET identifier_ciphertext = $2 WHERE seller_id = $1',
          [sellerId, ciphertext(40)],
          'seller_files_identifier_ciphertext_check',
        );
        // A clear number is not an envelope.
        await refuses(
          'UPDATE sellers.seller_files SET identifier_ciphertext = $2 WHERE seller_id = $1',
          [sellerId, '51824753556'.padEnd(41, '0')],
          'seller_files_identifier_ciphertext_check',
        );
        for (const bad of ['ABN', '1abn', 'a'.repeat(33), 'a_b', '']) {
          await refuses(
            'UPDATE sellers.seller_files SET identifier_scheme = $2 WHERE seller_id = $1',
            [sellerId, bad],
            'seller_files_identifier_scheme_check',
          );
        }
        for (const length of [0, 16, 31, 33, 64]) {
          await refuses(
            'UPDATE sellers.seller_files SET identifier_index = $2 WHERE seller_id = $1',
            [sellerId, Buffer.alloc(length, 1)],
            'seller_files_identifier_index_check',
          );
        }
        // All three or none.
        for (const sets of [
          'identifier_scheme = NULL',
          'identifier_ciphertext = NULL',
          'identifier_index = NULL',
        ]) {
          await refuses(
            `UPDATE sellers.seller_files SET ${sets} WHERE seller_id = $1`,
            [sellerId],
            'seller_files_identifier_set_check',
          );
        }
        await set(
          'identifier_scheme = NULL, identifier_ciphertext = NULL, identifier_index = NULL',
        );
        expect(await identifierRow(sellerId)).toMatchObject({
          identifier_scheme: null,
          identifier_ciphertext: null,
          identifier_index: null,
        });
      });

      it('has the partial index of the exact search and no unique key on the index', async () => {
        const { rows } = await owner.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE schemaname = 'sellers'
              AND indexname = 'seller_files_market_id_identifier_index_idx'`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.indexdef).toContain('(market_id, identifier_index)');
        expect(rows[0]!.indexdef).toContain('WHERE (identifier_index IS NOT NULL)');
        expect(rows[0]!.indexdef).not.toContain('UNIQUE');
        // A draft gives no right to a number (brief s7): two files may hold the same index.
        const first = await registerSeller(code);
        const second = await registerSeller(code);
        for (const sellerId of [first, second]) {
          await sql.query(
            `UPDATE sellers.seller_files SET identifier_scheme = $2, identifier_ciphertext = $3,
                    identifier_index = $4 WHERE seller_id = $1`,
            [sellerId, scheme, ciphertext(60), indexBytes(9)],
          );
        }
        const { rows: found } = await sql.query(
          `SELECT seller_id FROM sellers.seller_files
            WHERE market_id = $1 AND identifier_index = $2 ORDER BY seller_id`,
          [code, indexBytes(9)],
        );
        expect(found.map((r) => (r as { seller_id: string }).seller_id)).toEqual(
          [first, second].sort(),
        );
      });

      it('saves the number encrypted at rest, with its scheme and keyed index, and reads it back', async () => {
        const { sellerId, context } = await draftSeller();
        const saved = await app
          .get(MyFileSaveIdentifier)
          .execute(context, { identifier: IDENTIFIER.typed });
        expect(saved).toEqual({
          ok: true,
          value: {
            version: 2,
            draftComplete: false,
            missing: parts('storeName', 'businessName', 'phone', 'address', 'timezone', 'slug'),
            registerResult: null,
          },
        });
        const stored = await identifierRow(sellerId);
        expect(stored.identifier_scheme).toBe(scheme);
        expect(stored.identifier_ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
        expect(stored.identifier_ciphertext).not.toContain(IDENTIFIER.normalised);
        expect(stored.identifier_index).toHaveLength(32);
        // The index is the keyed hash of Market, scheme and number: exact search finds the file.
        const index = app.get<IdentifierIndex>(IDENTIFIER_INDEX);
        const expected = Buffer.from(
          index.of(marketOf(code), scheme, IDENTIFIER.normalised as NormalisedIdentifier),
        );
        expect(stored.identifier_index!.equals(expected)).toBe(true);
        expect(expected.includes(Buffer.from(IDENTIFIER.normalised))).toBe(false);
        const { rows: found } = await sql.query(
          'SELECT seller_id FROM sellers.seller_files WHERE market_id = $1 AND identifier_index = $2',
          [code, expected],
        );
        // Other files of this database may hold the same number (a draft gives no right to it).
        expect(found).toContainEqual({ seller_id: sellerId });
        // The same number in the other Market is another index (AC 21).
        expect(
          Buffer.from(
            index.of(marketOf(other), scheme, IDENTIFIER.normalised as NormalisedIdentifier),
          ).equals(expected),
        ).toBe(false);

        const read = await app.get(MyFileRead).execute(context, {});
        expect(read.ok && read.value.identifier).toEqual({
          value: IDENTIFIER.normalised,
          display: IDENTIFIER.display,
        });
        // The same number again is a no-op; a number bound to another column does not open.
        await app.get(MyFileSaveIdentifier).execute(context, { identifier: IDENTIFIER.normalised });
        expect((await identifierRow(sellerId)).version).toBe(2);
        await owner.query(
          `UPDATE sellers.seller_files SET phone_ciphertext = identifier_ciphertext
            WHERE market_id = $1 AND seller_id = $2`,
          [code, sellerId],
        );
        expect(await app.get(MyFileRead).execute(context, {})).toEqual({
          ok: false,
          error: { code: 'sellers.unavailable' },
        });
      });

      it('refuses a number of another scheme and a wrong checksum, validates without storing', async () => {
        const { sellerId, context } = await draftSeller();
        expect(
          await app.get(MyFileSaveIdentifier).execute(context, { identifier: foreign }),
        ).toEqual({ ok: false, error: { code: 'identifier.format' } });
        expect(
          await app.get(MyFileValidateIdentifier).execute(context, { identifier: foreign }),
        ).toEqual({ ok: false, error: { code: 'identifier.format' } });
        const lastDigit = IDENTIFIER.normalised.endsWith('9') ? '8' : '9';
        expect(
          await app.get(MyFileSaveIdentifier).execute(context, {
            identifier: IDENTIFIER.normalised.slice(0, -1) + lastDigit,
          }),
        ).toEqual({ ok: false, error: { code: 'identifier.checksum' } });
        expect(
          await app
            .get(MyFileValidateIdentifier)
            .execute(context, { identifier: IDENTIFIER.typed }),
        ).toEqual({ ok: true, value: { display: IDENTIFIER.display } });
        expect(await identifierRow(sellerId)).toMatchObject({
          identifier_scheme: null,
          identifier_ciphertext: null,
          identifier_index: null,
          version: 1,
        });
      });

      it('completes the draft with the number only where the Market requires it, and clears it', async () => {
        const { sellerId, context } = await draftSeller();
        await app.get(MyFileSaveGeneral).execute(context, GENERAL);
        await app.get(MyFileSaveAddress).execute(context, { address: FIXTURE.address });
        await app.get(MyFileSaveSlug).execute(context, { slug: `noor-${code.toLowerCase()}` });
        const withoutNumber = await identifierRow(sellerId);
        expect(withoutNumber.draft_complete).toBe(code === 'ZZ');
        await app.get(MyFileSaveIdentifier).execute(context, { identifier: IDENTIFIER.typed });
        expect((await identifierRow(sellerId)).draft_complete).toBe(true);
        const cleared = await app.get(MyFileSaveIdentifier).execute(context, { identifier: null });
        expect(cleared.ok && cleared.value.draftComplete).toBe(code === 'ZZ');
        expect(await identifierRow(sellerId)).toMatchObject({
          identifier_scheme: null,
          identifier_index: null,
          draft_complete: code === 'ZZ',
        });
      });

      it('keeps sellers apart: a file of the other Market is no file here, and nothing is written to it', async () => {
        const mine = await draftSeller();
        await app.get(MyFileSaveIdentifier).execute(mine.context, { identifier: IDENTIFIER.typed });
        // A file of the other Market, inserted as the owner (no sign-up: a sign-up in the other
        // Market would write its throttle windows with this Market's clock).
        const elsewhere = uniqueIds.next<'Seller'>();
        const otherTenant = marketOf(other).tenantId;
        await owner.query(
          `INSERT INTO sellers.seller_files
             (seller_id, market_id, tenant_id, origin, approval_required_at_registration,
              draft_complete, last_changed_at, version, created_at)
           VALUES ($1, $2, $3, 'self', true, false, now(), 1, now())`,
          [elsewhere, other, otherTenant],
        );
        const crossed = testCallContext(
          marketOf(code),
          testAuthenticatedActor(marketOf(code), {
            population: 'seller',
            accountId: (mine.context.actor as { accountId: Id<'Account'> }).accountId,
            sessionId: ids.next<'Session'>(),
            sellerId: elsewhere,
          }),
          `db-sellers-${randomUUID()}`,
        );
        expect(
          await app.get(MyFileSaveIdentifier).execute(crossed, { identifier: IDENTIFIER.typed }),
        ).toEqual({ ok: false, error: { code: 'file.not-found' } });
        expect(await app.get(MyFileRead).execute(crossed, {})).toEqual({
          ok: false,
          error: { code: 'file.not-found' },
        });
        const { rows } = await owner.query(
          'SELECT identifier_index, version FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2',
          [other, elsewhere],
        );
        expect(rows).toEqual([{ identifier_index: null, version: 1 }]);
        // Leave no stray file behind: other tests count the Market's files against its inbox.
        await owner.query(
          'DELETE FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2',
          [other, elsewhere],
        );
      });

      it('serves the routes over HTTP with the real use cases: no-store, codes only, CSRF', async () => {
        const { sellerId, headers } = await signUpSeller(code);
        const http = () => request(app.getHttpServer());

        const checked = await http()
          .post('/sellers/my-file/identifier-check')
          .set(headers)
          .send({ identifier: IDENTIFIER.typed });
        expect(checked.status).toBe(200);
        expect(checked.headers['cache-control']).toBe('no-store');
        expect(checked.body).toEqual({ display: IDENTIFIER.display });

        const refused = await http()
          .put('/sellers/my-file/identifier')
          .set(headers)
          .send({ identifier: foreign });
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ statusCode: 400, code: 'identifier.format' });
        expect(refused.text).not.toContain(foreign);

        const saved = await http()
          .put('/sellers/my-file/identifier')
          .set(headers)
          .send({ identifier: IDENTIFIER.typed });
        expect(saved.status).toBe(200);
        expect(saved.headers['cache-control']).toBe('no-store');
        expect(saved.body).toMatchObject({ version: 2, draftComplete: false });
        expect((saved.body as { missing: string[] }).missing).not.toContain('identifier');

        const read = await http().get('/sellers/my-file').set(headers);
        expect(read.status).toBe(200);
        expect((read.body as { identifier: unknown }).identifier).toEqual({
          value: IDENTIFIER.normalised,
          display: IDENTIFIER.display,
        });

        const descriptors = await http().get('/sellers/my-file/form-descriptors').set(headers);
        expect((descriptors.body as { identifier: unknown }).identifier).toEqual({
          scheme,
          labelKey: `sellers.business-identifier.${scheme}`,
          required: code === 'AU',
          maxLength: 64,
        });

        const noCsrf = await http()
          .put('/sellers/my-file/identifier')
          .set({ ...headers, 'x-csrf-token': 'wrong' })
          .send({ identifier: IDENTIFIER.typed });
        expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
        expect((await identifierRow(sellerId)).version).toBe(2);
      });

      describe('tax registration periods (V2)', () => {
        const SELLER_ZONE = FIXTURE.zones[0]!;
        const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1';
        const insertPeriod = (
          sellerId: string,
          from: string,
          to: string | null,
          overrides: Record<string, unknown> = {},
        ) =>
          sql.query(
            `INSERT INTO sellers.tax_registration_periods
               (id, market_id, tenant_id, seller_id, registered_for_indirect_tax,
                effective_from_local, effective_zone, valid_from, valid_to, recorded_by_kind,
                recorded_by_account_id, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              overrides.id ?? randomUUID(),
              overrides.market ?? code,
              overrides.tenant ?? 'default',
              sellerId,
              true,
              '2026-01-01',
              overrides.zone ?? SELLER_ZONE,
              from,
              to,
              overrides.kind ?? 'seller',
              ACCOUNT,
              '2026-10-08T00:00:00Z',
            ],
          );
        const periodsOf = async (sellerId: string) =>
          (
            await sql.query<{ id: string; valid_from: Date; valid_to: Date | null }>(
              `SELECT id, valid_from, valid_to FROM sellers.tax_registration_periods
                WHERE market_id = $1 AND seller_id = $2 ORDER BY valid_from`,
              [code, sellerId],
            )
          ).rows;

        it('refuses overlapping periods of one seller, accepts adjacent ones and other sellers', async () => {
          const a = await registerSeller(code);
          const b = await registerSeller(code);
          await insertPeriod(a, '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z');
          const overlap = (from: string, to: string | null) =>
            expect(insertPeriod(a, from, to)).rejects.toMatchObject({
              code: '23P01',
              constraint: 'tax_registration_periods_no_overlap_excl',
            });
          await overlap('2026-06-30T23:59:59.999Z', null);
          await overlap('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
          await overlap('2025-01-01T00:00:00Z', '2026-01-01T00:00:00.001Z');
          // Half-open: it may start exactly where the previous one ends.
          await insertPeriod(a, '2026-07-01T00:00:00Z', null);
          await overlap('2030-01-01T00:00:00Z', null);
          // Another seller of the Market may hold the same span.
          await insertPeriod(b, '2026-01-01T00:00:00Z', null);
          expect(await periodsOf(a)).toHaveLength(2);
          expect(await periodsOf(b)).toHaveLength(1);
        });

        it('refuses what the CHECKs, the foreign key and the grants refuse', async () => {
          const sellerId = await registerSeller(code);
          const check = (constraint: string, run: () => Promise<unknown>) =>
            expect(run()).rejects.toMatchObject({ code: '23514', constraint });
          await check('tax_registration_periods_valid_to_check', () =>
            insertPeriod(sellerId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          );
          await check('tax_registration_periods_valid_to_check', () =>
            insertPeriod(sellerId, '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          );
          await check('tax_registration_periods_recorded_by_kind_check', () =>
            insertPeriod(sellerId, '2026-01-01T00:00:00Z', null, { kind: 'system' }),
          );
          for (const zone of ['+10:00', 'Etc UTC', '', 'x'.repeat(65), '/Australia']) {
            await check('tax_registration_periods_effective_zone_check', () =>
              insertPeriod(sellerId, '2026-01-01T00:00:00Z', null, { zone }),
            );
          }
          await check('tax_registration_periods_market_id_check', () =>
            insertPeriod(sellerId, '2026-01-01T00:00:00Z', null, { market: 'au' }),
          );
          await check('tax_registration_periods_tenant_id_check', () =>
            insertPeriod(sellerId, '2026-01-01T00:00:00Z', null, { tenant: 'Default' }),
          );
          // The foreign key: a seller with no tax profile, or a profile of another Market.
          await expect(
            insertPeriod(randomUUID(), '2026-01-01T00:00:00Z', null),
          ).rejects.toMatchObject({ code: '23503' });
          await expect(
            sql.query(
              `INSERT INTO sellers.tax_registration_periods
                 (id, market_id, tenant_id, seller_id, registered_for_indirect_tax,
                  effective_from_local, effective_zone, valid_from, recorded_by_kind,
                  recorded_by_account_id, recorded_at)
               VALUES ($1, $2, 'default', $3, true, '2026-01-01', 'UTC', now(), 'seller', $4, now())`,
              [randomUUID(), other, sellerId, ACCOUNT],
            ),
          ).rejects.toMatchObject({ code: '23503' });
          expect(await periodsOf(sellerId)).toEqual([]);

          // Grants: only valid_to may change (and a row may be deleted); a start never moves.
          await insertPeriod(sellerId, '2026-01-01T00:00:00Z', null);
          for (const set of [
            "valid_from = valid_from + interval '1 day'",
            'registered_for_indirect_tax = false',
            "effective_zone = 'UTC'",
            "recorded_by_kind = 'admin'",
          ]) {
            await expect(
              sql.query(`UPDATE sellers.tax_registration_periods SET ${set} WHERE seller_id = $1`, [
                sellerId,
              ]),
            ).rejects.toMatchObject({ code: '42501' });
          }
          await sql.query(
            `UPDATE sellers.tax_registration_periods SET valid_to = '2027-01-01T00:00:00Z'
              WHERE seller_id = $1`,
            [sellerId],
          );
          expect((await periodsOf(sellerId))[0]!.valid_to).toEqual(
            new Date('2027-01-01T00:00:00Z'),
          );
        });

        it('records a period through the aggregate and repository: closes the open one, as of any instant', async () => {
          const { sellerId } = await draftSeller();
          const repository = app.get<TaxProfileRepository>(TAX_PROFILE_REPOSITORY);
          const unit = app.get<UnitOfWork>(UNIT_OF_WORK);
          const market = marketOf(code);
          const by = { kind: 'seller', accountId: ACCOUNT as Id<'Account'> } as const;

          const first = await unit.run<boolean, never>(market, async () => {
            const profile = (await repository.findBySellerId(market, sellerId))!;
            expect(profile.periods).toEqual([]);
            const recorded = profile.record({
              periodId: uniqueIds.next<'TaxRegistrationPeriod'>(),
              registeredForIndirectTax: true,
              effectiveFromLocal: Temporal.PlainDate.from('2026-03-10'),
              zone: SELLER_ZONE,
              by,
              now: clock.now(),
            });
            expect(recorded.ok).toBe(true);
            return ok(await repository.save(market, profile));
          });
          expect(first).toEqual({ ok: true, value: true });
          const second = await unit.run<boolean, never>(market, async () => {
            const profile = (await repository.findBySellerId(market, sellerId))!;
            expect(profile.version).toBe(2);
            profile.record({
              periodId: uniqueIds.next<'TaxRegistrationPeriod'>(),
              registeredForIndirectTax: false,
              effectiveFromLocal: null,
              zone: SELLER_ZONE,
              by,
              now: clock.now(),
            });
            return ok(await repository.save(market, profile));
          });
          expect(second).toEqual({ ok: true, value: true });

          const rows = await periodsOf(sellerId);
          expect(rows).toHaveLength(2);
          const start = Temporal.PlainDate.from('2026-03-10')
            .toZonedDateTime({ timeZone: SELLER_ZONE })
            .toInstant();
          expect(rows[0]!.valid_from.getTime()).toBe(start.epochMilliseconds);
          expect(rows[0]!.valid_to).toEqual(rows[1]!.valid_from);
          expect(rows[1]!.valid_to).toBeNull();
          const { rows: profileRow } = await sql.query(
            'SELECT version FROM sellers.seller_tax_profiles WHERE market_id = $1 AND seller_id = $2',
            [code, sellerId],
          );
          expect(profileRow).toEqual([{ version: 3 }]);
          const { rows: stored } = await sql.query(
            `SELECT effective_from_local::text AS local, effective_zone, registered_for_indirect_tax AS yes
               FROM sellers.tax_registration_periods WHERE seller_id = $1 ORDER BY valid_from`,
            [sellerId],
          );
          expect(stored).toEqual([
            { local: '2026-03-10', effective_zone: SELLER_ZONE, yes: true },
            {
              local: clock.now().toZonedDateTimeISO(SELLER_ZONE).toPlainDate().toString(),
              effective_zone: SELLER_ZONE,
              yes: false,
            },
          ]);

          // As of an instant (ADR-0007 decision 7): the ranged query of data design 3.7.
          const asOf = async (at: string) =>
            (
              await sql.query<{ yes: boolean }>(
                `SELECT registered_for_indirect_tax AS yes FROM sellers.tax_registration_periods
                  WHERE market_id = $1 AND seller_id = $2 AND valid_from <= $3
                    AND (valid_to IS NULL OR valid_to > $3)`,
                [code, sellerId, at],
              )
            ).rows;
          expect(await asOf(start.subtract({ milliseconds: 1 }).toString())).toEqual([]);
          expect(await asOf(start.toString())).toEqual([{ yes: true }]);
          expect(await asOf(rows[1]!.valid_from.toISOString())).toEqual([{ yes: false }]);
          const reloaded = await unit.run(market, async () =>
            ok((await repository.findBySellerId(market, sellerId))!.asOf(start)?.effectiveZone),
          );
          expect(reloaded).toEqual({ ok: true, value: SELLER_ZONE });
        });

        it('cancels a period that has not started and re-opens the previous one', async () => {
          const { sellerId } = await draftSeller();
          const repository = app.get<TaxProfileRepository>(TAX_PROFILE_REPOSITORY);
          const unit = app.get<UnitOfWork>(UNIT_OF_WORK);
          const market = marketOf(code);
          const by = { kind: 'admin', accountId: ACCOUNT as Id<'Account'> } as const;
          const record = (from: string) =>
            unit.run<boolean, never>(market, async () => {
              const profile = (await repository.findBySellerId(market, sellerId))!;
              const result = profile.record({
                periodId: uniqueIds.next<'TaxRegistrationPeriod'>(),
                registeredForIndirectTax: true,
                effectiveFromLocal: Temporal.PlainDate.from(from),
                zone: SELLER_ZONE,
                by,
                now: clock.now(),
              });
              if (!result.ok) throw new Error(result.error.code);
              return ok(await repository.save(market, profile));
            });
          await record('2026-01-01');
          await record('2027-02-01');
          const before = await periodsOf(sellerId);
          expect(before[0]!.valid_to).toEqual(before[1]!.valid_from);

          const cancelled = await unit.run<boolean, never>(market, async () => {
            const profile = (await repository.findBySellerId(market, sellerId))!;
            const result = profile.cancel(
              before[1]!.id as Id<'TaxRegistrationPeriod'>,
              clock.now(),
            );
            expect(result.ok).toBe(true);
            return ok(await repository.save(market, profile));
          });
          expect(cancelled).toEqual({ ok: true, value: true });
          const after = await periodsOf(sellerId);
          expect(after).toHaveLength(1);
          expect(after[0]!.id).toBe(before[0]!.id);
          expect(after[0]!.valid_to).toBeNull();

          // A started period cannot be cancelled: the aggregate refuses before any statement.
          const started = await unit.run(market, async () => {
            const profile = (await repository.findBySellerId(market, sellerId))!;
            return ok(profile.cancel(after[0]!.id as Id<'TaxRegistrationPeriod'>, clock.now()));
          });
          expect(started).toEqual({
            ok: true,
            value: { ok: false, error: { code: 'tax.period-started' } },
          });
        });

        it('writes nothing when another unit changed the profile first, and the database keeps the chain', async () => {
          const { sellerId } = await draftSeller();
          const repository = app.get<TaxProfileRepository>(TAX_PROFILE_REPOSITORY);
          const unit = app.get<UnitOfWork>(UNIT_OF_WORK);
          const market = marketOf(code);
          const by = { kind: 'seller', accountId: ACCOUNT as Id<'Account'> } as const;
          const attempt = (from: string) =>
            unit.run<boolean, never>(market, async () => {
              const profile = (await repository.findBySellerId(market, sellerId))!;
              profile.record({
                periodId: uniqueIds.next<'TaxRegistrationPeriod'>(),
                registeredForIndirectTax: true,
                effectiveFromLocal: Temporal.PlainDate.from(from),
                zone: SELLER_ZONE,
                by,
                now: clock.now(),
              });
              // Another unit commits between this unit's read and its write.
              await sql.query(
                'UPDATE sellers.seller_tax_profiles SET version = version + 1 WHERE seller_id = $1',
                [sellerId],
              );
              return ok(await repository.save(market, profile));
            });
          expect(await attempt('2026-01-01')).toEqual({ ok: true, value: false });
          expect(await periodsOf(sellerId)).toEqual([]);

          // Two parallel recordings for one seller: both read the same version, exactly one commits.
          let loaded = 0;
          let release!: () => void;
          const bothLoaded = new Promise<void>((resolve) => {
            release = resolve;
          });
          const results = await Promise.all(
            ['2026-02-01', '2026-03-01'].map((from) =>
              unit.run<boolean, never>(market, async () => {
                const profile = (await repository.findBySellerId(market, sellerId))!;
                loaded += 1;
                if (loaded === 2) release();
                await Promise.race([
                  bothLoaded,
                  new Promise((resolve) => setTimeout(resolve, 5_000)),
                ]);
                profile.record({
                  periodId: uniqueIds.next<'TaxRegistrationPeriod'>(),
                  registeredForIndirectTax: true,
                  effectiveFromLocal: Temporal.PlainDate.from(from),
                  zone: SELLER_ZONE,
                  by,
                  now: clock.now(),
                });
                return ok(await repository.save(market, profile));
              }),
            ),
          );
          const committed = results.filter((r) => r.ok && r.value).length;
          expect(committed).toBe(1);
          expect(await periodsOf(sellerId)).toHaveLength(1);
        });
      });
    });

    describe('slice 4a: register checks and the register lookup', () => {
      const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1';
      const rules = code === 'AU' ? abnScheme : zzCorpNoScheme;
      const length = code === 'AU' ? 11 : 9;
      const scheme = rules.scheme;
      const ORIGIN = '203.0.113.5';
      const SETTINGS = {
        kind: 'configured',
        adapter: FAKE_REGISTER_ADAPTER,
        maxResultAgeDays: 30,
        perAccountLimit: 2,
        perOriginLimit: 5,
        marketDailyBudget: 50,
        legalSuffixes: ['pty ltd'],
      } as const;
      const active = (count: number, skip = 0) =>
        validIdentifiers(rules, length, count, ['3', '4', '5', '6', '7', '8', '9'], skip);
      const indexOf = (marketCode: string, text: string) =>
        identifierIndexKeyOf(
          app
            .get<IdentifierIndex>(IDENTIFIER_INDEX)
            .of(marketOf(marketCode), scheme, text as NormalisedIdentifier),
        );
      const repository = () => new PrismaRegisterCheckRepository(app.get(PrismaService));
      const inUnit = async <T>(marketCode: string, work: () => Promise<T>): Promise<T> => {
        const result = await app
          .get<UnitOfWork>(UNIT_OF_WORK)
          .run(marketOf(marketCode), async () => ok(await work()));
        if (!result.ok) throw new Error('the unit failed');
        return result.value;
      };
      const checkRows = async (sellerId: string) =>
        (
          await sql.query<Record<string, unknown>>(
            `SELECT outcome, mismatches, definite_negative_at, compared_values_ciphertext,
                    checked_by_kind, checked_by_account_id, encode(identifier_index, 'hex') AS idx
               FROM sellers.register_checks WHERE market_id = $1 AND seller_id = $2
              ORDER BY checked_at, idx`,
            [code, sellerId],
          )
        ).rows;
      const counterRows = async (kind: string) =>
        Number(
          (
            await sql.query<{ n: string }>(
              'SELECT count(*) AS n FROM sellers.rate_counters WHERE market_id = $1 AND kind = $2',
              [code, kind],
            )
          ).rows[0]!.n,
        );
      const at = '2026-10-08T00:00:00Z';
      /** A fresh 32-byte index. */
      const withIndex = (): Buffer =>
        Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex');
      const insert = (sellerId: string, overrides: Record<string, unknown> = {}) =>
        sql.query(
          `INSERT INTO sellers.register_checks
             (market_id, tenant_id, seller_id, identifier_index, outcome, mismatches,
              definite_negative_at, compared_values_ciphertext, checked_at, checked_by_kind,
              checked_by_account_id, compared_file_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            overrides.market ?? code,
            overrides.tenant ?? 'default',
            sellerId,
            overrides.index ?? withIndex(),
            overrides.outcome ?? 'active',
            'mismatches' in overrides ? overrides.mismatches : [],
            overrides.mark ?? null,
            overrides.ciphertext ?? null,
            at,
            overrides.kind ?? 'seller',
            'account' in overrides ? overrides.account : ACCOUNT,
            overrides.version ?? 2,
          ],
        );
      const refuses = (promise: Promise<unknown>, constraint: string) =>
        expect(promise).rejects.toMatchObject({ code: '23514', constraint });
      const ciphertext = (n: number) => `v1.${'A'.repeat(n - 3)}`;

      it('holds the CHECKs of data design 3.4: accepted and refused rows', async () => {
        const sellerId = await registerSeller(code);
        const row = (overrides: Record<string, unknown> = {}) => insert(sellerId, overrides);
        // Accepted.
        await row({ outcome: 'active', mismatches: ['postcode', 'business-name'] });
        await row({ outcome: 'not-found', mark: at });
        await row({ outcome: 'cancelled', mark: at });
        await row({ outcome: 'unavailable' });
        await row({ outcome: 'unavailable', mark: at });
        await row({ kind: 'job', account: null });
        await row({ kind: 'reviewer' });
        await row({ ciphertext: ciphertext(41) });
        await row({ ciphertext: ciphertext(2048) });
        // Refused.
        await refuses(row({ outcome: 'verified' }), 'register_checks_outcome_check');
        await refuses(row({ mismatches: ['name'] }), 'register_checks_mismatches_check');
        for (const outcome of ['not-found', 'cancelled', 'unavailable']) {
          await refuses(
            row({ outcome, mark: at, mismatches: ['postcode'] }),
            'register_checks_mismatches_check',
          );
        }
        for (const outcome of ['not-found', 'cancelled']) {
          await refuses(row({ outcome }), 'register_checks_definite_negative_check');
        }
        await refuses(
          row({ outcome: 'active', mark: at }),
          'register_checks_definite_negative_check',
        );
        await refuses(
          row({ kind: 'job', account: ACCOUNT }),
          'register_checks_checked_by_account_id_check',
        );
        for (const kind of ['seller', 'reviewer']) {
          await refuses(
            row({ kind, account: null }),
            'register_checks_checked_by_account_id_check',
          );
        }
        await refuses(row({ kind: 'bot' }), 'register_checks_checked_by_kind_check');
        for (const bytes of [0, 16, 31, 33]) {
          await refuses(
            row({ index: Buffer.alloc(bytes, 1) }),
            'register_checks_identifier_index_check',
          );
        }
        for (const bad of [ciphertext(40), ciphertext(2049), '51824753556'.padEnd(41, '0')]) {
          await refuses(
            row({ ciphertext: bad }),
            'register_checks_compared_values_ciphertext_check',
          );
        }
        await refuses(row({ market: 'au' }), 'register_checks_market_id_check');
        await refuses(row({ tenant: 'Default' }), 'register_checks_tenant_id_check');
        // A NULL mismatch list is refused by the NOT NULL the migration adds.
        await expect(row({ mismatches: null })).rejects.toMatchObject({ code: '23502' });
      });

      it('keys a row by Market, file and value; the file and the Market are foreign keys; sellers do not share', async () => {
        const first = await registerSeller(code);
        const second = await registerSeller(code);
        const shared = withIndex();
        await insert(first, { index: shared });
        await expect(insert(first, { index: shared })).rejects.toMatchObject({
          code: '23505',
          constraint: 'register_checks_pkey',
        });
        // Another seller may hold a result for the same value: results are per file.
        await insert(second, { index: shared });
        // A file that does not exist, and the right file under another Market, are refused.
        await expect(insert(randomUUID())).rejects.toMatchObject({
          code: '23503',
          constraint: 'register_checks_market_id_seller_id_fkey',
        });
        await expect(insert(first, { market: other })).rejects.toMatchObject({ code: '23503' });
        // RESTRICT: a file with a result is not deleted from under it.
        await expect(
          owner.query('DELETE FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2', [
            code,
            first,
          ]),
        ).rejects.toMatchObject({ code: '23503' });
      });

      it('grants the application role select, insert and update, and no delete', async () => {
        const sellerId = await registerSeller(code);
        const index = withIndex();
        await insert(sellerId, { index });
        await sql.query(
          `UPDATE sellers.register_checks SET outcome = 'unavailable'
            WHERE market_id = $1 AND seller_id = $2 AND identifier_index = $3`,
          [code, sellerId, index],
        );
        await expect(
          sql.query('DELETE FROM sellers.register_checks WHERE seller_id = $1', [sellerId]),
        ).rejects.toMatchObject({ code: '42501' });
      });

      describe('PrismaRegisterCheckRepository', () => {
        const T0 = Temporal.Instant.from('2026-10-08T12:00:00Z');
        const seller = { kind: 'seller', accountId: ACCOUNT as Id<'Account'> } as const;
        const write = (
          outcome: 'active' | 'not-found' | 'cancelled' | 'unavailable',
          when: Temporal.Instant = T0,
          mismatches: ('postcode' | 'business-name')[] = [],
        ) => ({
          outcome,
          mismatches,
          checkedAt: when,
          checkedBy: seller,
          comparedFileVersion: 2,
        });

        it('records and finds the latest result of a value, with the sticky negative of AC 31', async () => {
          const sellerId = await registerSeller(code);
          const [number] = active(1);
          const index = indexOf(code, number!);
          const m = marketOf(code);
          expect(await inUnit(code, () => repository().find(m, sellerId, index))).toBeNull();

          const first = await inUnit(code, () =>
            repository().record(m, sellerId, index, write('not-found')),
          );
          expect(first).toEqual({
            outcome: 'not-found',
            mismatches: [],
            definiteNegativeAt: T0,
            checkedAt: T0,
            checkedBy: seller,
            comparedFileVersion: 2,
          });
          // A later unavailable keeps the mark and the first instant; the latest outcome is kept.
          const later = T0.add({ hours: 1 });
          const after = await inUnit(code, () =>
            repository().record(m, sellerId, index, write('unavailable', later)),
          );
          expect(after).toMatchObject({
            outcome: 'unavailable',
            definiteNegativeAt: T0,
            checkedAt: later,
          });
          // Another negative keeps the first mark.
          const third = await inUnit(code, () =>
            repository().record(m, sellerId, index, write('cancelled', later.add({ hours: 1 }))),
          );
          expect(third).toMatchObject({ outcome: 'cancelled', definiteNegativeAt: T0 });
          // An active answer replaces the negative and carries its flags.
          const answered = await inUnit(code, () =>
            repository().record(
              m,
              sellerId,
              index,
              write('active', later.add({ hours: 2 }), ['postcode']),
            ),
          );
          expect(answered).toEqual({
            outcome: 'active',
            mismatches: ['postcode'],
            definiteNegativeAt: null,
            checkedAt: later.add({ hours: 2 }),
            checkedBy: seller,
            comparedFileVersion: 2,
          });
          expect(await inUnit(code, () => repository().find(m, sellerId, index))).toEqual(answered);
          expect(await checkRows(sellerId)).toHaveLength(1);
        });

        it('keeps a definite negative when an unavailable answer races it', async () => {
          const sellerId = await registerSeller(code);
          const m = marketOf(code);
          const numbers = active(4);
          for (const [position, number] of numbers.entries()) {
            const index = indexOf(code, number);
            // Some rounds start from an existing row, others from none.
            if (position % 2 === 1) {
              await inUnit(code, () =>
                repository().record(m, sellerId, index, write('unavailable')),
              );
            }
            await Promise.all([
              inUnit(code, () => repository().record(m, sellerId, index, write('not-found'))),
              inUnit(code, () => repository().record(m, sellerId, index, write('unavailable'))),
              inUnit(code, () => repository().record(m, sellerId, index, write('unavailable'))),
            ]);
            const stored = await inUnit(code, () => repository().find(m, sellerId, index));
            expect(stored?.definiteNegativeAt).toEqual(T0);
          }
        });

        it('never reads or writes a seller of another Market', async () => {
          const sellerId = await registerSeller(code);
          const index = indexOf(code, active(1)[0]!);
          await inUnit(code, () =>
            repository().record(marketOf(code), sellerId, index, write('active')),
          );
          expect(
            await inUnit(other, () => repository().find(marketOf(other), sellerId, index)),
          ).toBeNull();
          await expect(
            inUnit(other, () =>
              repository().record(marketOf(other), sellerId, index, write('active')),
            ),
          ).rejects.toThrow();
          expect(await checkRows(sellerId)).toHaveLength(1);
        });
      });

      describe('the use cases against PostgreSQL (fake register, no network)', () => {
        const adminContext = (marketCode: string) =>
          testCallContext(
            marketOf(marketCode),
            testAuthenticatedActor(marketOf(marketCode), {
              population: 'admin',
              accountId: ids.next<'Account'>(),
              sessionId: ids.next<'Session'>(),
              sellerId: null,
            }),
            `db-sellers-${randomUUID()}`,
          );
        const save = (context: CallContext, identifier: unknown, origin: string | null = ORIGIN) =>
          app.get(MyFileSaveIdentifier).execute(context, { identifier, origin });
        const QUOTA_KINDS = ['lookup.account', 'lookup.origin', 'lookup.market'];

        it('asks the register, keeps only outcome, flags and instant, and shows each side its view', async () => {
          registerPolicy.set(code, SETTINGS);
          const { sellerId, context } = await draftSeller();
          const [number] = active(1);

          const saved = await save(context, number);

          expect(saved.ok && saved.value.registerResult).toBe('matched');
          expect(fakeRegister.calls).toHaveLength(1);
          expect(await checkRows(sellerId)).toEqual([
            {
              outcome: 'active',
              mismatches: [],
              definite_negative_at: null,
              compared_values_ciphertext: null,
              checked_by_kind: 'seller',
              checked_by_account_id:
                context.actor.kind === 'authenticated' ? context.actor.accountId : null,
              idx: Buffer.from(indexOf(code, number!)).toString('hex'),
            },
          ]);
          // The three quotas were reserved before the call.
          for (const kind of QUOTA_KINDS) expect(await counterRows(kind)).toBeGreaterThan(0);
          // Neither the number nor a register value is in the row.
          const dump = JSON.stringify(
            (
              await sql.query('SELECT r.* FROM sellers.register_checks r WHERE seller_id = $1', [
                sellerId,
              ])
            ).rows,
          );
          expect(dump).not.toContain(number);
          expect(dump).not.toContain('Fake Trading');

          const read = await app.get(MyFileRead).execute(context, {});
          expect(read.ok && read.value.registerResult).toBe('matched');
          const review = await app
            .get(ReviewRegisterCheckRead)
            .execute(adminContext(code), { sellerId });
          expect(review).toEqual({
            ok: true,
            value: {
              lookup: 'configured',
              identifierSaved: true,
              state: 'active',
              mismatches: [],
              staleReason: null,
              checkedAt: clock.now().toString(),
              checkedBy: 'seller',
              blocksSubmit: false,
              blocksApproval: false,
            },
          });
          // A reviewer of another Market does not find this seller (AC 1).
          expect(
            await app.get(ReviewRegisterCheckRead).execute(adminContext(other), { sellerId }),
          ).toEqual({ ok: false, error: { code: 'file.not-found' } });
        });

        it('stores a definite negative and shows the seller one message', async () => {
          registerPolicy.set(code, SETTINGS);
          const { sellerId, context } = await draftSeller();
          const [number] = validIdentifiers(rules, length, 1, ['0']);

          const saved = await save(context, number);

          expect(saved.ok && saved.value.registerResult).toBe('not-matched');
          const [row] = await checkRows(sellerId);
          expect(row).toMatchObject({ outcome: 'not-found' });
          expect(row!.definite_negative_at).toBeInstanceOf(Date);
          const review = await app
            .get(ReviewRegisterCheckRead)
            .execute(adminContext(code), { sellerId });
          expect(review.ok && review.value).toMatchObject({
            state: 'negative',
            blocksSubmit: true,
            blocksApproval: true,
          });
        });

        it('refuses the third new number of an account with lookup.limit and writes nothing for it', async () => {
          registerPolicy.set(code, SETTINGS);
          const { sellerId, context } = await draftSeller();
          const numbers = active(3);
          expect((await save(context, numbers[0])).ok).toBe(true);
          expect((await save(context, numbers[1])).ok).toBe(true);

          const refused = await save(context, numbers[2]);

          expect(refused).toEqual({
            ok: false,
            error: { code: 'lookup.limit', retryAfterSeconds: expect.any(Number) as unknown },
          });
          expect(fakeRegister.calls).toHaveLength(2);
          expect(await checkRows(sellerId)).toHaveLength(2);
          const read = await app.get(MyFileRead).execute(context, {});
          expect(read.ok && read.value.identifier?.value).toBe(numbers[1]);
          // The number the file holds, saved again, changes nothing: no quota, no call.
          expect((await save(context, numbers[1])).ok).toBe(true);
          expect(fakeRegister.calls).toHaveLength(2);
          // A number that comes back was compared against an older version of the draft (slice 5,
          // Hassan M1 residual): its result is stale, so it is due again and counts.
          const back = await save(context, numbers[0]);
          expect(back).toEqual({
            ok: false,
            error: { code: 'lookup.limit', retryAfterSeconds: expect.any(Number) as unknown },
          });
          expect(fakeRegister.calls).toHaveLength(2);
        });

        it('reserves nothing and writes nothing in a Market with no register (`none`)', async () => {
          const { sellerId, context } = await draftSeller();
          const before = await Promise.all(QUOTA_KINDS.map(counterRows));

          const saved = await save(context, active(1)[0], null);

          expect(saved.ok && saved.value.registerResult).toBeNull();
          expect(fakeRegister.calls).toHaveLength(0);
          expect(await checkRows(sellerId)).toEqual([]);
          expect(await Promise.all(QUOTA_KINDS.map(counterRows))).toEqual(before);
          const review = await app
            .get(ReviewRegisterCheckRead)
            .execute(adminContext(code), { sellerId });
          expect(review.ok && review.value).toMatchObject({
            lookup: 'none',
            state: 'not-performed',
          });
        });

        it('records a failing adapter as an unavailable register', async () => {
          registerPolicy.set(code, SETTINGS);
          const { sellerId, context } = await draftSeller();
          fakeRegister.failWith = new Error('connection reset');

          const saved = await save(context, active(1)[0]);

          expect(saved.ok && saved.value.registerResult).toBe('could-not-be-checked');
          expect(await checkRows(sellerId)).toEqual([
            expect.objectContaining({ outcome: 'unavailable', definite_negative_at: null }),
          ]);
        });
      });
    });
  });
});
