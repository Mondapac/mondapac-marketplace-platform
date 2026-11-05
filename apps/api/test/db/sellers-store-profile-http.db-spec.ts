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
import sharp from 'sharp';
import request from 'supertest';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { REVIEWER_NOTIFIER } from '../../src/modules/sellers/application/ports/reviewer-notifier';
import {
  SERVICE_AREAS,
  type ServiceAreas,
} from '../../src/modules/sellers/application/ports/seller-market-formats';
import { BUSINESS_REGISTER_LOOKUPS } from '../../src/modules/sellers/application/ports/business-register-lookup';
import { REGISTER_LOOKUP_POLICY } from '../../src/modules/sellers/application/ports/register-lookup-policy';
import { abnScheme } from '../../src/modules/sellers/infrastructure/identifier-schemes/abn';
import { zzCorpNoScheme } from '../../src/modules/sellers/infrastructure/identifier-schemes/zz-corp-no';
import { MyFileSaveAddress } from '../../src/modules/sellers/application/use-cases/my-file-save-address.use-case';
import { MyFileSaveGeneral } from '../../src/modules/sellers/application/use-cases/my-file-save-general.use-case';
import { MyFileSaveIdentifier } from '../../src/modules/sellers/application/use-cases/my-file-save-identifier.use-case';
import { MyFileSaveSlug } from '../../src/modules/sellers/application/use-cases/my-file-save-slug.use-case';
import { MyFileSubmit } from '../../src/modules/sellers/application/use-cases/my-file-submit.use-case';
import { ReviewApprove } from '../../src/modules/sellers/application/use-cases/review-approve.use-case';
import { ReviewRecordManualCheck } from '../../src/modules/sellers/application/use-cases/review-record-manual-check.use-case';
import { LateBoundStoreTextClaimCheck } from '../../src/modules/sellers/infrastructure/late-bound-store-text-claim-check';
import { MarketConfigRegisterLookups } from '../../src/modules/sellers/infrastructure/register-lookups';
import {
  FAKE_REGISTER_ADAPTER,
  FakeRegisterLookup,
} from '../../src/modules/sellers/infrastructure/register-lookups/fake';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { MemoryObjectStore } from '../../src/platform/storage/disk-object-store';
import { OBJECT_STORE } from '../../src/platform/storage/object-store';
import { FakeNotifier } from '../support/sellers-submit-fakes';
import { FixedRegisterLookupPolicy, validIdentifiers } from '../support/sellers-register-fakes';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { storeProfileOwnerTestDatabaseUrl, storeProfileTestDatabaseUrl } from './test-database';

// The seller's store profile end to end on PostgreSQL (sellers slice 12 part 2), for both Market
// fixtures: the whole application over HTTP, real identity, real authorisation, real certification
// claim vocabulary and real repositories (only the mail transport, the reviewer notifier, the
// register and the object store are test doubles). One approved seller saves the About text,
// uploads a logo, reads their own image, is seen on the public store page and image route,
// replaces the logo (the old public image is gone at once) and removes it. The Hassan H3 wiring is
// proved here too: with the real `SellerStoreProfileModule` a text holding a seeded claim term is
// refused as `about.<locale>` `claim-term`, and an application where the binding never happened
// refuses the save (fail closed). Runs on its own copy of the run database (global-setup.ts).

const PASSWORD = 'correct horse battery staple';
const TOKEN_IN_URL = /#(ml1_[A-Za-z0-9_-]{43})$/m;
const ORIGIN = '203.0.113.7';
const T0 = '2026-10-08T00:00:00Z';

/** One published claim term per Market, in its default locale: never valid in the other Market. */
const CLAIM_TERM = { AU: 'ausealed', ZZ: 'zzsealed' } as const;

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

const png = (width: number, height: number, background = '#1a7a5a') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

describe.each(TEST_MARKETS)('store profile over HTTP on PostgreSQL in market %s', (code) => {
  const market = marketOf(code);
  const otherCode = code === 'AU' ? 'ZZ' : 'AU';
  const clock = new FixedClock(Temporal.Instant.from(T0));
  const transport = new CapturingTransport();
  const ids = new SequenceIdGenerator(clock);
  const registerPolicy = new FixedRegisterLookupPolicy();
  const areas: ServiceAreas = {
    areaFor: () => ({ code: 'test-area', sellerOnboardingEnabled: true }),
  };
  let app: NestExpressApplication;
  let sql: Client;
  let owner: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let store: MemoryObjectStore;
  let reviewer: Id<'Account'>;
  let logs: jest.SpyInstance[];
  const http = () => request(app.getHttpServer());

  const FIXTURE = {
    AU: {
      address: { line1: '1 George St', suburb: 'Brisbane', state: 'QLD', postcode: '4000' },
      // Distinct valid numbers whose last digit the register fake answers `active` for.
      identifiers: validIdentifiers(abnScheme, 11, 8, ['3']),
    },
    ZZ: {
      address: { street: '1 Main', district: 'Central', prefecture: 'ZB', postalCode: '1000001' },
      identifiers: validIdentifiers(zzCorpNoScheme, 9, 8, ['3']),
    },
  }[code];
  let identifierNo = 0;
  const GENERAL = {
    storeName: 'Al Noor Grocer',
    businessName: 'Al Noor Trading Pty Ltd',
    phone: '+61 7 3000 0000',
    contactEmail: 'shop.canary@example.com',
  };
  const publicHeaders = { 'x-market-id': code };

  beforeAll(async () => {
    sql = new Client({ connectionString: storeProfileTestDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: storeProfileOwnerTestDatabaseUrl() });
    await owner.connect();
    await seedClaimTerm();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
  });

  /** Publishes a vocabulary of one claim term in this Market's default locale (as the seed would). */
  async function seedClaimTerm(): Promise<void> {
    const typeId = randomUUID();
    const revisionId = randomUUID();
    const scope = [code, 'default'];
    const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO certification.certification_types
           (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
         VALUES ($1, $2, $3, 'sp-claim', 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $4)`,
        [typeId, ...scope, T0],
      );
      await owner.query(
        `INSERT INTO certification.certification_type_revisions
           (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
            requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
            badge_icon_key, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, 1, 'THIRD_PARTY_DOCUMENT', true, true, true, 'SELLER_REQUIRED', false,
                 'halal', $5, $6)`,
        [revisionId, ...scope, typeId, randomUUID(), T0],
      );
      await owner.query(
        `INSERT INTO certification.type_revision_texts
           (market_id, tenant_id, type_revision_id, locale, name, customer_description)
         VALUES ($1, $2, $3, $4, 'Name', 'Description')`,
        [...scope, revisionId, locale],
      );
      await owner.query(
        `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
         VALUES ($1, $2, $3, $4, $5)`,
        [...scope, revisionId, locale, CLAIM_TERM[code]],
      );
      await owner.query(
        'UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2',
        [revisionId, typeId],
      );
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  async function boot(): Promise<void> {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    registerPolicy.set(code, { kind: 'none' });
    store = new MemoryObjectStore();
    ({ app } = await createTestApp({
      env: { DATABASE_URL: storeProfileTestDatabaseUrl() },
      panelOrigins: true,
      override: (builder) =>
        builder
          .overrideProvider(MAIL_TRANSPORT)
          .useValue(transport)
          .overrideProvider(OBJECT_STORE)
          .useValue(store)
          .overrideProvider(SERVICE_AREAS)
          .useValue(areas)
          .overrideProvider(REVIEWER_NOTIFIER)
          .useValue(new FakeNotifier())
          .overrideProvider(REGISTER_LOOKUP_POLICY)
          .useValue(registerPolicy)
          .overrideProvider(BUSINESS_REGISTER_LOOKUPS)
          .useValue(
            new MarketConfigRegisterLookups(
              registerPolicy,
              new Map([[FAKE_REGISTER_ADAPTER, new FakeRegisterLookup()]]),
            ),
          ),
    }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-profile-${randomUUID()}`), {});
    reviewer = await newReviewer();
  }

  async function shutdown(): Promise<void> {
    await app.close();
    logs.forEach((spy) => spy.mockRestore());
  }

  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  /** An active admin of this Market holding the platform administrator role. */
  async function newReviewer(): Promise<Id<'Account'>> {
    const id = `01990000-0000-7000-8000-${randomUUID().slice(-12)}` as Id<'Account'>;
    const email = `reviewer.${id}@profile.example`;
    await owner.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
         email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $3, 'Reviewer', 'active', now(), now(), 1, now())`,
      [id, code, email],
    );
    await owner.query(
      `INSERT INTO identity.password_credentials (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn', now())`,
      [code, id],
    );
    await owner.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
         assigned_by_account_id, assigned_at, version)
       SELECT $3::uuid, market_id, tenant_id, $2::uuid, id, NULL, now(), 1 FROM identity.roles
        WHERE market_id = $1 AND scope = 'platform' AND seed_code = 'platform-administrator'`,
      [code, id, randomUUID()],
    );
    return id;
  }

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: reviewer,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      `db-profile-${randomUUID()}`,
    );

  async function signUpSeller(): Promise<{
    sellerId: Id<'Seller'>;
    headers: Record<string, string>;
  }> {
    const email = `Seller.Owner+${randomUUID()}@Example.com`;
    const post = (path: string, body: object) =>
      http()
        .post(`/identity/seller/${path}`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send(body);
    expect(
      (await post('sign-up', { displayName: 'Amina Rahman', email, password: PASSWORD })).status,
    ).toBe(202);
    await settle();
    const mail = transport.sent.filter((message) => message.to === email)[0]!;
    const confirmed = await post('confirm-email', { token: tokenOf(mail), password: PASSWORD });
    expect(confirmed.status).toBe(200);
    await settle();
    const { rows } = await sql.query<{ seller_id: string; account_id: string }>(
      `SELECT m.seller_id, m.account_id FROM identity.seller_memberships m
         JOIN identity.accounts a ON a.market_id = m.market_id AND a.id = m.account_id
        WHERE a.market_id = $1 AND a.email_normalized = $2`,
      [code, email.toLowerCase()],
    );
    const [cookie] = (confirmed.headers['set-cookie'] as unknown as string[])[0]!.split(';', 1);
    return {
      sellerId: rows[0]!.seller_id as Id<'Seller'>,
      headers: {
        'x-market-id': code,
        ...panelHeaders(code, 'seller'),
        cookie: cookie!,
        'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
      },
    };
  }

  /** A seller whose file is complete, submitted and approved by a reviewer: a store that sells. */
  async function approvedSeller(): Promise<{
    sellerId: Id<'Seller'>;
    headers: Record<string, string>;
    slug: string;
  }> {
    const { sellerId, headers } = await signUpSeller();
    await owner.query(
      `UPDATE identity.seller_access SET state = 'pending' WHERE market_id = $1 AND seller_id = $2`,
      [code, sellerId],
    );
    const { rows } = await sql.query<{ account_id: string }>(
      'SELECT account_id FROM identity.seller_memberships WHERE seller_id = $1',
      [sellerId],
    );
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: rows[0]!.account_id as Id<'Account'>,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
      `db-profile-${randomUUID()}`,
    );
    const slug = `shop-${randomUUID().slice(0, 8)}`;
    for (const step of [
      await app.get(MyFileSaveGeneral).execute(context, GENERAL),
      await app.get(MyFileSaveAddress).execute(context, { address: FIXTURE.address }),
      await app.get(MyFileSaveSlug).execute(context, { slug }),
      await app
        .get(MyFileSaveIdentifier)
        .execute(context, { identifier: FIXTURE.identifiers[identifierNo++]!, origin: ORIGIN }),
    ]) {
      expect(step.ok).toBe(true);
    }
    expect((await app.get(MyFileSubmit).execute(context, { origin: ORIGIN })).ok).toBe(true);
    const { rows: revisions } = await sql.query<{ id: string }>(
      'SELECT id FROM sellers.business_file_revisions WHERE market_id = $1 AND seller_id = $2',
      [code, sellerId],
    );
    const revisionId = revisions[0]!.id;
    const first = await app.get(ReviewApprove).execute(admin(), { sellerId, revisionId });
    if (!first.ok) {
      expect(first.error.code).toBe('review.manual-register-check-required');
      expect(
        (
          await app.get(ReviewRecordManualCheck).execute(admin(), {
            sellerId,
            revisionId,
            observedOutcome: 'active',
          })
        ).ok,
      ).toBe(true);
      const second = await app.get(ReviewApprove).execute(admin(), { sellerId, revisionId });
      expect(second).toMatchObject({ ok: true });
    }
    await settle();
    return { sellerId, headers, slug };
  }

  const imageBody = async (width: number, height: number, background?: string) => ({
    data: (await png(width, height, background)).toString('base64'),
  });

  describe('with the claim check bound (the real application)', () => {
    beforeAll(boot);
    afterAll(shutdown);

    it('runs the whole flow: About, logo, own image, public page, replace, remove', async () => {
      const { sellerId, headers, slug } = await approvedSeller();
      const text = 'Family bakery.\nWe bake bread and cakes every morning.';

      // An empty profile: version 0, no images, the limits and the Market locales.
      const empty = await http().get('/sellers/store-profile').set(headers);
      expect(empty.status).toBe(200);
      expect(empty.headers['cache-control']).toBe('no-store');
      const { defaultLocale, locales } = empty.body as { defaultLocale: string; locales: string[] };
      expect(empty.body).toMatchObject({ version: 0, logo: null, banner: null });
      expect(locales).toContain(defaultLocale);

      // The About text: saved at once as version 1; a second save with the old version is stale.
      const saved = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({ expectedVersion: 0, about: { [defaultLocale]: text } });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ version: 1, about: { [defaultLocale]: text } });
      const stale = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({ expectedVersion: 0, about: { [defaultLocale]: 'Other' } });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'conflict.stale' });

      // The logo: two renditions, the ref in the answer; the image routes are last-write-wins.
      const withVersion = await http()
        .put('/sellers/store-profile/logo')
        .set(headers)
        .send({ ...(await imageBody(600, 400)), expectedVersion: 1 });
      expect(withVersion.status).toBe(400);
      const logo = await http()
        .put('/sellers/store-profile/logo')
        .set(headers)
        .send(await imageBody(600, 400));
      expect(logo.status).toBe(200);
      const first = (logo.body as { logo: { id: string; width: number; height: number } }).logo;
      expect(first).toMatchObject({ width: 512, height: 512 });
      expect(store.objects.size).toBe(2);

      // The seller's own preview of both sizes, private; the public cannot use this route.
      const own = await http()
        .get(`/sellers/store-profile/images/${first.id}/small`)
        .set(headers)
        .buffer(true);
      expect(own.status).toBe(200);
      expect(own.headers['content-type']).toBe('image/jpeg');
      expect(own.headers['cache-control']).toBe('private, no-store');
      expect((await sharp(own.body as Buffer).metadata()).width).toBe(128);
      expect(
        (await http().get(`/sellers/store-profile/images/${first.id}/small`).set(publicHeaders))
          .status,
      ).toBe(401);

      // S6: an unknown size and an id that is not an id are the same 404.
      const unknownSize = await http()
        .get(`/sellers/store-profile/images/${first.id}/huge`)
        .set(headers);
      const notAnId = await http()
        .get('/sellers/store-profile/images/not-an-id/small')
        .set(headers);
      expect(unknownSize.status).toBe(404);
      expect(notAnId.status).toBe(404);
      expect(notAnId.body).toEqual(unknownSize.body);
      expect(unknownSize.body).toEqual({ statusCode: 404, code: 'image.not-found' });

      // The public store page shows the About text and the logo ref; no banner yet.
      const page = await http().get(`/sellers/stores/${slug}`).set(publicHeaders);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ about: text, logo: first, banner: null });
      const list = await http().get('/sellers/stores').set(publicHeaders);
      expect(JSON.stringify(list.body)).toContain(first.id);
      expect(JSON.stringify(list.body)).not.toContain('bake bread');

      // The public image bytes: cacheable, nosniff, nothing allowed by the CSP.
      const bytes = await http()
        .get(`/sellers/stores/${slug}/images/${first.id}/large`)
        .set(publicHeaders)
        .buffer(true);
      expect(bytes.status).toBe(200);
      expect(bytes.headers['content-type']).toBe('image/jpeg');
      expect(bytes.headers['cache-control']).toBe('public, max-age=300');
      expect(bytes.headers['x-content-type-options']).toBe('nosniff');
      expect(bytes.headers['content-security-policy']).toContain("default-src 'none'");
      expect((await sharp(bytes.body as Buffer).metadata()).width).toBe(512);

      // Another store's slug, an unknown slug, a size that does not exist and a wrong id are alike.
      const alike = [
        await http()
          .get(`/sellers/stores/no-such-store/images/${first.id}/large`)
          .set(publicHeaders),
        await http().get(`/sellers/stores/${slug}/images/${first.id}/huge`).set(publicHeaders),
        await http().get(`/sellers/stores/${slug}/images/not-an-id/large`).set(publicHeaders),
        await http()
          .get(`/sellers/stores/${slug}/images/0199dddd-0000-7000-8000-000000000999/large`)
          .set(publicHeaders),
      ];
      for (const answer of alike) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ statusCode: 404, code: 'image.not-found' });
      }

      // Replace: the old public and own image are gone at once, the new one is served; the old
      // objects are deleted from the store.
      const replaced = await http()
        .put('/sellers/store-profile/logo')
        .set(headers)
        .send(await imageBody(300, 300, '#aa3322'));
      expect(replaced.status).toBe(200);
      const second = (replaced.body as { logo: { id: string } }).logo;
      expect(second.id).not.toBe(first.id);
      expect(store.objects.size).toBe(2);
      for (const route of [
        `/sellers/stores/${slug}/images/${first.id}/large`,
        `/sellers/stores/${slug}/images/${first.id}/small`,
      ]) {
        const gone = await http().get(route).set(publicHeaders);
        expect(gone.status).toBe(404);
        expect(gone.body).toEqual(alike[0]!.body);
      }
      expect(
        (await http().get(`/sellers/store-profile/images/${first.id}/small`).set(headers)).status,
      ).toBe(404);
      expect(
        (await http().get(`/sellers/stores/${slug}/images/${second.id}/small`).set(publicHeaders))
          .status,
      ).toBe(200);

      // A banner joins; then both are removed: the public routes stop at once.
      const banner = await http()
        .put('/sellers/store-profile/banner')
        .set(headers)
        .send(await imageBody(1600, 500));
      expect(banner.status).toBe(200);
      expect(banner.body).toMatchObject({ banner: { width: 1536, height: 384 } });
      expect(store.objects.size).toBe(4);
      const removed = await http().delete('/sellers/store-profile/logo').set(headers);
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ logo: null });
      expect(
        (await http().get(`/sellers/stores/${slug}/images/${second.id}/small`).set(publicHeaders))
          .status,
      ).toBe(404);
      expect(
        ((await http().get(`/sellers/stores/${slug}`).set(publicHeaders)).body as { logo: unknown })
          .logo,
      ).toBeNull();
      expect(store.objects.size).toBe(2);
      // Removing what is not there is a quiet success.
      expect((await http().delete('/sellers/store-profile/logo').set(headers)).status).toBe(200);
      expect((await http().delete('/sellers/store-profile/banner').set(headers)).status).toBe(200);
      expect(store.objects.size).toBe(0);

      // A second About save (version 1 to 2) publishes a second event: it must not collide with
      // the first on the outbox key, and both share one store-profile aggregate id.
      const secondSave = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({ expectedVersion: 1, about: { [defaultLocale]: 'Family bakery, open daily.' } });
      expect(secondSave.status).toBe(200);
      expect(secondSave.body).toMatchObject({ version: 2 });

      // The text is encrypted at rest and appears in no audit row, event or outbox payload.
      const { rows: revisions } = await sql.query(
        'SELECT content_ciphertext, content_hash FROM sellers.store_profile_revisions WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId],
      );
      expect(revisions).toHaveLength(2);
      expect(JSON.stringify(revisions)).not.toContain('bake bread');
      const { rows: audit } = await sql.query(
        `SELECT action, before, after FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 AND action LIKE 'sellers.store-%'
          ORDER BY occurred_at`,
        [code, sellerId],
      );
      expect(audit.map((row: { action: string }) => row.action)).toEqual([
        'sellers.store-profile.saved',
        'sellers.store-image.changed',
        'sellers.store-image.changed',
        'sellers.store-image.changed',
        'sellers.store-image.changed',
        'sellers.store-image.changed',
        'sellers.store-profile.saved',
      ]);
      expect(audit[0]).toMatchObject({
        after: { revisionId: expect.any(String) as unknown, revisionNo: 1 },
      });
      expect(JSON.stringify(audit)).not.toContain('bake bread');
      const { rows: events } = await sql.query(
        `SELECT aggregate_id, aggregate_version, payload FROM sellers.outbox
          WHERE market_id = $1 AND payload->>'sellerId' = $2 AND type = 'sellers.store-profile-published.v1'
          ORDER BY aggregate_version`,
        [code, sellerId],
      );
      expect(events).toHaveLength(2);
      expect(events.map((row: { aggregate_version: number }) => row.aggregate_version)).toEqual([
        1, 2,
      ]);
      const aggregateIds = new Set(events.map((row: { aggregate_id: string }) => row.aggregate_id));
      expect(aggregateIds.size).toBe(1);
      expect(aggregateIds.has(sellerId)).toBe(false);
      expect(JSON.stringify(events)).not.toContain('bake bread');
    });

    it('refuses a text holding a seeded claim term as about.<locale> claim-term, and saves nothing (H3, S9)', async () => {
      const { headers } = await approvedSeller();
      const locale = (
        (await http().get('/sellers/store-profile').set(headers)).body as {
          defaultLocale: string;
        }
      ).defaultLocale;

      const refused = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({
          expectedVersion: 0,
          about: { [locale]: `Our meat is ${CLAIM_TERM[code]} daily.` },
        });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: `about.${locale}`, code: 'claim-term' }] },
      });
      // The vocabulary is per Market: the other Market's term is only a word here.
      const other = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({
          expectedVersion: 0,
          about: { [locale]: `Our meat is ${CLAIM_TERM[otherCode]} daily.` },
        });
      expect(other.status).toBe(200);
      expect(other.body).toMatchObject({ version: 1 });
    });

    it('lists the Market claim terms for the live warning: this Market only, no-store', async () => {
      const { headers } = await approvedSeller();

      const answer = await http().get('/sellers/store-profile/claim-terms').set(headers);

      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({ terms: [CLAIM_TERM[code]] });
      expect(JSON.stringify(answer.body)).not.toContain(CLAIM_TERM[otherCode]);
    });

    it('names only the locale that holds the term, whatever the other locales say', async () => {
      const { headers } = await approvedSeller();
      const view = (await http().get('/sellers/store-profile').set(headers)).body as {
        defaultLocale: string;
        locales: string[];
      };
      const second = view.locales.find((locale) => locale !== view.defaultLocale);
      const refused = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({
          expectedVersion: 0,
          about: {
            [view.defaultLocale]: `Fresh ${CLAIM_TERM[code]}`,
            // AU offers one locale only; ZZ also writes its second locale, which is clean.
            ...(second === undefined ? {} : { [second]: 'Fresh bread' }),
          },
        });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        details: { fields: [{ path: `about.${view.defaultLocale}`, code: 'claim-term' }] },
      });
    });
  });

  describe('with the claim check never bound (a wiring fault)', () => {
    let bind: jest.SpyInstance;
    beforeAll(async () => {
      bind = jest.spyOn(LateBoundStoreTextClaimCheck.prototype, 'bind').mockImplementation(() => {
        // The binding module's onModuleInit ran, but the real check was not installed.
      });
      await boot();
    });
    afterAll(async () => {
      await shutdown();
      bind.mockRestore();
    });

    it('answers the claim terms as 503, never an empty list', async () => {
      const { headers } = await approvedSeller();

      const answer = await http().get('/sellers/store-profile/claim-terms').set(headers);

      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ code: 'sellers.unavailable' });
    });

    it('fails closed: the save answers 503 sellers.unavailable and nothing is stored', async () => {
      const { sellerId, headers } = await approvedSeller();
      const view = (await http().get('/sellers/store-profile').set(headers)).body as {
        defaultLocale: string;
      };

      const refused = await http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send({ expectedVersion: 0, about: { [view.defaultLocale]: 'Fresh bread daily.' } });

      expect(bind).toHaveBeenCalled();
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ code: 'sellers.unavailable' });
      const { rows } = await sql.query(
        'SELECT 1 FROM sellers.store_profile_revisions WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
