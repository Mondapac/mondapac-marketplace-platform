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
import { REVIEWER_NOTIFIER } from '../../src/modules/sellers/application/ports/reviewer-notifier';
import {
  SERVICE_AREAS,
  type ServiceAreas,
} from '../../src/modules/sellers/application/ports/seller-market-formats';
import { MyFileRead } from '../../src/modules/sellers/application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from '../../src/modules/sellers/application/use-cases/my-file-save-address.use-case';
import { MyFileSaveGeneral } from '../../src/modules/sellers/application/use-cases/my-file-save-general.use-case';
import { MyFileSaveIdentifier } from '../../src/modules/sellers/application/use-cases/my-file-save-identifier.use-case';
import { MyFileSaveSlug } from '../../src/modules/sellers/application/use-cases/my-file-save-slug.use-case';
import { MyFileSubmit } from '../../src/modules/sellers/application/use-cases/my-file-submit.use-case';
import { MyFileWithdraw } from '../../src/modules/sellers/application/use-cases/my-file-withdraw.use-case';
import {
  APPROVED_SELLER_ZONES,
  type ApprovedSellerZonesReader,
} from '../../src/modules/sellers/contracts/approved-seller-zones.contract';
import { BUSINESS_REGISTER_LOOKUPS } from '../../src/modules/sellers/application/ports/business-register-lookup';
import { REGISTER_LOOKUP_POLICY } from '../../src/modules/sellers/application/ports/register-lookup-policy';
import { MarketConfigRegisterLookups } from '../../src/modules/sellers/infrastructure/register-lookups';
import {
  FAKE_REGISTER_ADAPTER,
  FakeRegisterLookup,
} from '../../src/modules/sellers/infrastructure/register-lookups/fake';
import { AUTHORISATION_CHECK, type AuthorisationCheck } from '../../src/platform/authz';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { FakeNotifier } from '../support/sellers-submit-fakes';
import { FixedRegisterLookupPolicy, validIdentifiers } from '../support/sellers-register-fakes';
import { abnScheme } from '../../src/modules/sellers/infrastructure/identifier-schemes/abn';
import { zzCorpNoScheme } from '../../src/modules/sellers/infrastructure/identifier-schemes/zz-corp-no';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { sellerSubmitOwnerTestDatabaseUrl, sellerSubmitTestDatabaseUrl } from './test-database';

// Sellers slice 5b on PostgreSQL (sellers design 3.1, 6.2, 7.3 to 7.5; data design 3.2, 3.11, 22),
// for both Market fixtures: the real use cases through the real unit of work. What the in-memory
// suite (my-file-submit.use-case.spec.ts) shows with fakes is shown here with row locks, the
// unique keys and real concurrency: the submission and its event, the withdrawal, the withdrawal
// by an edit, the races of Hassan's review, the reviewer notice and its counters, and the approved
// zone read. This file runs on its own copy of the run database (global-setup.ts): the relay and
// the dispatcher claim every due row of a Market.

const PASSWORD = 'correct horse battery staple';
const TOKEN_IN_URL = /#(ml1_[A-Za-z0-9_-]{43})$/m;
const ORIGIN = '203.0.113.7';

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

/** Admits an authenticated seller (or admin) under a permission rule; sellers' own logic is tested. */
const sellerOwnerCheck: AuthorisationCheck = {
  check: (context, declaration) =>
    Promise.resolve(
      context.actor.kind === 'authenticated' &&
        ((context.actor.population === 'seller' && context.actor.sellerId !== null) ||
          context.actor.population === 'admin') &&
        declaration.rule.kind === 'permissions'
        ? { allowed: true }
        : { allowed: false, denial: { code: 'access.denied' } },
    ),
};

describe.each(TEST_MARKETS)('sellers submission in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = code === 'AU' ? 'ZZ' : 'AU';
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z'));
  const transport = new CapturingTransport();
  const ids = new SequenceIdGenerator(clock);
  let app: NestExpressApplication;
  let sql: Client;
  let owner: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let logs: jest.SpyInstance[];
  let notifier: FakeNotifier;
  let fakeRegister: FakeRegisterLookup;
  const registerPolicy = new FixedRegisterLookupPolicy();
  const area = { open: true };
  const areas: ServiceAreas = {
    areaFor: () => ({ code: 'test-area', sellerOnboardingEnabled: area.open }),
  };

  const FIXTURE = {
    AU: {
      address: { line1: '1 George St', suburb: 'Brisbane', state: 'QLD', postcode: '4000' },
      editLine: 'line1',
      identifier: '51 824 753 556',
      zone: 'Australia/Brisbane',
    },
    ZZ: {
      address: { street: '1 Main', district: 'Central', prefecture: 'ZB', postalCode: '1000001' },
      editLine: 'street',
      identifier: '123-456-782',
      zone: 'Pacific/Auckland',
    },
  }[code];
  const GENERAL = {
    storeName: 'Al Noor Grocer',
    businessName: 'Al Noor Trading Pty Ltd',
    phone: '+61 7 3000 0000',
    contactEmail: 'shop.canary@example.com',
  };

  beforeAll(async () => {
    sql = new Client({ connectionString: sellerSubmitTestDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: sellerSubmitOwnerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
  });

  beforeEach(async () => {
    // A new application and a new day per test: the rate limits of an earlier test do not carry over.
    notifier = new FakeNotifier();
    fakeRegister = new FakeRegisterLookup();
    registerPolicy.set(code, { kind: 'none' });
    area.open = true;
    clock.advance(Temporal.Duration.from({ hours: 25 }));
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    ({ app } = await createTestApp({
      env: { DATABASE_URL: sellerSubmitTestDatabaseUrl() },
      panelOrigins: true,
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(MAIL_TRANSPORT)
          .useValue(transport)
          .overrideProvider(AUTHORISATION_CHECK)
          .useValue(sellerOwnerCheck)
          .overrideProvider(SERVICE_AREAS)
          .useValue(areas)
          .overrideProvider(REVIEWER_NOTIFIER)
          .useValue(notifier)
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
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-submit-${randomUUID()}`), {});
    // Events an earlier test left undelivered are handled now, before this test counts anything.
    await settle();
    notifier.calls.length = 0;
    await owner.query('DELETE FROM sellers.rate_counters WHERE market_id = $1', [code]);
  });
  afterEach(async () => {
    await app.close();
    logs.forEach((spy) => spy.mockRestore());
  });

  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  async function signUpSeller(): Promise<{
    sellerId: Id<'Seller'>;
    headers: Record<string, string>;
  }> {
    const email = `Seller.Owner+${randomUUID()}@Example.com`;
    const post = (path: string, body: object) =>
      request(app.getHttpServer())
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
    const { rows } = await sql.query<{ seller_id: string }>(
      `SELECT m.seller_id FROM identity.seller_memberships m
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

  async function contextOf(marketCode: string, sellerId: string): Promise<CallContext> {
    const { rows } = await sql.query<{ account_id: string }>(
      'SELECT account_id FROM identity.seller_memberships WHERE seller_id = $1',
      [sellerId],
    );
    const m = marketOf(marketCode);
    return testCallContext(
      m,
      testAuthenticatedActor(m, {
        population: 'seller',
        accountId: rows[0]!.account_id as Id<'Account'>,
        sessionId: ids.next<'Session'>(),
        sellerId: sellerId as Id<'Seller'>,
      }),
      `db-submit-${randomUUID()}`,
    );
  }

  /** A registered seller whose identity state is `pending` (ZZ registers as approved), complete. */
  async function readySeller(
    slug = `shop-${randomUUID().slice(0, 8)}`,
    identifier = FIXTURE.identifier,
  ) {
    const { sellerId, headers } = await signUpSeller();
    await owner.query(
      `UPDATE identity.seller_access SET state = 'pending' WHERE market_id = $1 AND seller_id = $2`,
      [code, sellerId],
    );
    const context = await contextOf(code, sellerId);
    for (const step of [
      await app.get(MyFileSaveGeneral).execute(context, GENERAL),
      await app.get(MyFileSaveAddress).execute(context, { address: FIXTURE.address }),
      await app.get(MyFileSaveSlug).execute(context, { slug }),
      await app.get(MyFileSaveIdentifier).execute(context, { identifier, origin: ORIGIN }),
    ]) {
      expect(step.ok).toBe(true);
    }
    return { sellerId, headers, context, slug };
  }

  const submit = (context: CallContext) =>
    app.get(MyFileSubmit).execute(context, { origin: ORIGIN });
  const withdraw = (context: CallContext) => app.get(MyFileWithdraw).execute(context, {});

  const revisions = async (sellerId: string) =>
    (
      await sql.query<Record<string, unknown>>(
        `SELECT id, kind, revision_no, status, author_kind, register_outcome, register_checked_at,
                operating_timezone, address_timezone, service_area_code, content_ciphertext,
                identifier_index IS NOT NULL AS has_index, withdraw_cause, withdrawn_by_kind,
                withdrawn_at
           FROM sellers.business_file_revisions
          WHERE market_id = $1 AND seller_id = $2 ORDER BY revision_no`,
        [code, sellerId],
      )
    ).rows;
  const fileVersion = async (sellerId: string) =>
    (
      await sql.query<{ version: number }>(
        'SELECT version FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId],
      )
    ).rows[0]!.version;
  const events = async (sellerId: string) =>
    (
      await sql.query<{
        type: string;
        aggregate_version: number;
        payload: Record<string, unknown>;
      }>(
        `SELECT type, aggregate_version, payload FROM sellers.outbox
          WHERE market_id = $1 AND aggregate_id = $2 AND type LIKE 'sellers.business-file-%'
          ORDER BY aggregate_version`,
        [code, sellerId],
      )
    ).rows;
  const slugRows = async (sellerId: string) =>
    (
      await sql.query<{ slug: string; state: string }>(
        'SELECT slug, state FROM sellers.shop_slugs WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId],
      )
    ).rows;
  const noticeCounts = async () =>
    (
      await sql.query<{ kind: string; count: number }>(
        `SELECT kind, count FROM sellers.rate_counters
          WHERE market_id = $1 AND kind LIKE 'reviewer-notice.%' ORDER BY kind`,
        [code],
      )
    ).rows;

  it('submits: the revision, the sealed content, the held slug, the event and the file version', async () => {
    const { sellerId, context, slug } = await readySeller();
    const before = await fileVersion(sellerId);

    const result = await submit(context);

    expect(result).toMatchObject({
      ok: true,
      value: { revisionNo: 1, version: before + 1, resubmission: false },
    });
    expect(await fileVersion(sellerId)).toBe(before + 1);
    const [revision, ...rest] = await revisions(sellerId);
    expect(rest).toEqual([]);
    expect(revision).toMatchObject({
      kind: 'onboarding',
      revision_no: 1,
      status: 'pending',
      author_kind: 'seller',
      register_outcome: 'not-performed',
      register_checked_at: null,
      operating_timezone: FIXTURE.zone,
      address_timezone: FIXTURE.zone,
      service_area_code: 'test-area',
      has_index: true,
    });
    // The content is ciphertext: no value of the draft is in the row.
    const text = JSON.stringify(revision);
    for (const value of ['Al Noor', GENERAL.phone, GENERAL.contactEmail, FIXTURE.identifier]) {
      expect(text).not.toContain(value);
    }
    expect(await slugRows(sellerId)).toEqual([{ slug, state: 'held' }]);
    expect(await events(sellerId)).toEqual([
      {
        type: 'sellers.business-file-submitted.v1',
        aggregate_version: before + 1,
        payload: {
          sellerId,
          revisionId: revision!.id,
          kind: 'onboarding',
          authorKind: 'seller',
          resubmission: false,
        },
      },
    ]);
  });

  it('tells the reviewers once after a submission and keeps both coalescing reservations', async () => {
    const { sellerId, context } = await readySeller();
    await submit(context);

    await settle();

    expect(notifier.calls).toEqual([sellerId]);
    expect(await noticeCounts()).toEqual([
      { kind: 'reviewer-notice.market', count: 1 },
      { kind: 'reviewer-notice.seller', count: 1 },
    ]);
    const { rows } = await sql.query(
      `SELECT 1 FROM sellers.inbox WHERE market_id = $1 AND handler = 'sellers.after-submission'`,
      [code],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await settle();
    expect(notifier.calls).toHaveLength(1);
  });

  it('releases both reservations when identity skips the notice (the guarded decrement)', async () => {
    const { context } = await readySeller();
    notifier.answers = ['skipped'];
    await submit(context);

    await settle();

    expect(notifier.calls).toHaveLength(1);
    expect(await noticeCounts()).toEqual([
      { kind: 'reviewer-notice.market', count: 0 },
      { kind: 'reviewer-notice.seller', count: 0 },
    ]);
  });

  it('coalesces a second seller into the Market window, keeping both counters', async () => {
    const first = await readySeller();
    const second = await readySeller();
    await submit(first.context);
    await settle();
    await submit(second.context);
    await settle();

    expect(notifier.calls).toEqual([first.sellerId]);
  });

  it('withdraws: the revision closed as cancelled, the draft kept, the event at the next version', async () => {
    const { sellerId, context } = await readySeller();
    await submit(context);
    const submitted = await fileVersion(sellerId);

    const result = await withdraw(context);

    expect(result).toEqual({ ok: true, value: { version: submitted + 1 } });
    expect(await revisions(sellerId)).toEqual([
      expect.objectContaining({
        status: 'withdrawn',
        withdraw_cause: 'cancelled',
        withdrawn_by_kind: 'seller',
        withdrawn_at: expect.any(Date) as Date,
      }),
    ]);
    expect((await events(sellerId)).map((e) => [e.type, e.aggregate_version])).toEqual([
      ['sellers.business-file-submitted.v1', submitted],
      ['sellers.business-file-withdrawn.v1', submitted + 1],
    ]);
    expect(await withdraw(context)).toEqual({
      ok: false,
      error: { code: 'file.nothing-to-withdraw' },
    });
    // A new submission after a withdrawal is a resubmission with the next number.
    const again = await submit(context);
    expect(again).toMatchObject({ ok: true, value: { revisionNo: 2, resubmission: true } });
    expect((await revisions(sellerId)).map((r) => r.status)).toEqual(['withdrawn', 'pending']);
  });

  it('withdraws the submission when the draft is edited, in the same unit and at the edit version', async () => {
    const { sellerId, context } = await readySeller();
    const edits = [
      () =>
        app.get(MyFileSaveGeneral).execute(context, { ...GENERAL, businessName: 'Other Trading' }),
      () =>
        app
          .get(MyFileSaveAddress)
          .execute(context, { address: { ...FIXTURE.address, [FIXTURE.editLine]: '2 Other Rd' } }),
      () =>
        app.get(MyFileSaveSlug).execute(context, { slug: `edited-${randomUUID().slice(0, 6)}` }),
    ];
    for (const edit of edits) {
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      expect((await submit(context)).ok).toBe(true);

      const saved = await edit();

      expect(saved).toMatchObject({ ok: true, value: { submissionWithdrawn: true } });
      const latest = (await revisions(sellerId)).at(-1)!;
      expect(latest).toMatchObject({ status: 'withdrawn', withdraw_cause: 'edited' });
      const version = (saved as { value: { version: number } }).value.version;
      expect(await fileVersion(sellerId)).toBe(version);
      expect((await events(sellerId)).at(-1)).toMatchObject({
        type: 'sellers.business-file-withdrawn.v1',
        aggregate_version: version,
      });
    }
    // Every event of the file is at a version of its own (the unique key held throughout).
    const versions = (await events(sellerId)).map((e) => e.aggregate_version);
    expect(new Set(versions).size).toBe(versions.length);
    // The slug changed after a first submission: the old hold went with the edit.
    expect(await slugRows(sellerId)).toEqual([]);
  });

  it('keeps one winner when a submission races a save: never a pending revision of a draft that changed', async () => {
    const { sellerId, context } = await readySeller();
    let current = GENERAL.businessName;
    for (let round = 0; round < 6; round += 1) {
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      const name = `Race Trading ${round}`;

      const [submitted, saved] = await Promise.all([
        submit(context),
        app.get(MyFileSaveGeneral).execute(context, { ...GENERAL, businessName: name }),
      ]);

      // Each answered with a result, never an error: the loser of a version race says
      // conflict.stale, and the two cannot both lose (one of them wrote at the version read).
      if (!submitted.ok) expect(submitted.error.code).toBe('conflict.stale');
      if (!saved.ok) expect(saved.error.code).toBe('conflict.stale');
      expect(submitted.ok || saved.ok).toBe(true);
      if (saved.ok) current = name;
      const rows = await revisions(sellerId);
      const pending = rows.filter((row) => row.status === 'pending');
      expect(pending.length).toBeLessThanOrEqual(1);
      const read = await app.get(MyFileRead).execute(context, {});
      expect(read.ok && read.value.general.businessName).toBe(current);
      if (pending.length === 1) {
        // The submission that stands judged the draft as it is now (the save came first, or lost).
        expect(submitted.ok).toBe(true);
        expect(read.ok && read.value.status).toBe('awaiting-review');
        if (saved.ok) expect(saved.value.submissionWithdrawn).toBe(false);
        expect((await withdraw(context)).ok).toBe(true);
      } else if (submitted.ok) {
        // The save came after the submission: it withdrew what it found.
        expect(saved.ok && saved.value.submissionWithdrawn).toBe(true);
        expect(rows.at(-1)).toMatchObject({ status: 'withdrawn', withdraw_cause: 'edited' });
      }
      const versions = (await events(sellerId)).map((e) => e.aggregate_version);
      expect(new Set(versions).size).toBe(versions.length);
    }
  });

  it('keeps one pending revision when two submissions race', async () => {
    const { sellerId, context } = await readySeller();

    const results = await Promise.all([submit(context), submit(context), submit(context)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results) {
      if (!result.ok) {
        expect(['file.already-submitted', 'conflict.stale']).toContain(result.error.code);
      }
    }
    expect(await revisions(sellerId)).toHaveLength(1);
    expect((await events(sellerId)).filter((e) => e.type.endsWith('submitted.v1'))).toHaveLength(1);
  });

  it('lets one of two sellers hold a slug; the loser leaves nothing behind', async () => {
    const slug = `both-${randomUUID().slice(0, 8)}`;
    const first = await readySeller(slug);
    const second = await readySeller(slug);
    const versions = [await fileVersion(first.sellerId), await fileVersion(second.sellerId)];

    const results = await Promise.all([submit(first.context), submit(second.context)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loserIndex = results[0].ok ? 1 : 0;
    const loser = [first, second][loserIndex]!;
    expect(results[loserIndex]).toEqual({ ok: false, error: { code: 'slug.taken' } });
    expect(await revisions(loser.sellerId)).toEqual([]);
    expect(await slugRows(loser.sellerId)).toEqual([]);
    expect(await fileVersion(loser.sellerId)).toBe(versions[loserIndex]);
    expect(await events(loser.sellerId)).toEqual([]);
    const { rows } = await sql.query(
      'SELECT 1 FROM sellers.shop_slugs WHERE market_id = $1 AND slug = $2',
      [code, slug],
    );
    expect(rows).toHaveLength(1);
  });

  it('asks the register in the submission when there is no current result, and refuses a definite negative', async () => {
    registerPolicy.set(code, {
      kind: 'configured',
      adapter: FAKE_REGISTER_ADAPTER,
      maxResultAgeDays: 30,
      perAccountLimit: 5,
      perOriginLimit: 30,
      marketDailyBudget: 1000,
      legalSuffixes: [],
    });
    const active = await readySeller(undefined, activeNumber());
    // The number was saved with the register on: the result is current for the version submitted.
    expect(fakeRegister.calls).toHaveLength(1);
    await submit(active.context);
    expect(fakeRegister.calls).toHaveLength(1);
    expect((await revisions(active.sellerId))[0]).toMatchObject({ register_outcome: 'active' });

    // A negative number: the save stores the definite negative, the submission refuses it.
    const refused = await readySeller();
    await app
      .get(MyFileSaveIdentifier)
      .execute(refused.context, { identifier: negativeNumber(), origin: ORIGIN });
    expect(await submit(refused.context)).toEqual({
      ok: false,
      error: { code: 'identifier.not-matched' },
    });
    expect(await revisions(refused.sellerId)).toEqual([]);
    expect(await slugRows(refused.sellerId)).toEqual([]);
  });

  /** A valid number of the Market's scheme that the fake register answers "active" (ends in 3 to 9). */
  const activeNumber = (): string =>
    code === 'AU'
      ? validIdentifiers(abnScheme, 11, 1, ['3'])[0]!
      : validIdentifiers(zzCorpNoScheme, 9, 1, ['3'])[0]!;

  /** A valid number of the Market's scheme that the fake register answers "not found" (ends in 0). */
  const negativeNumber = (): string =>
    code === 'AU'
      ? validIdentifiers(abnScheme, 11, 1, ['0'])[0]!
      : validIdentifiers(zzCorpNoScheme, 9, 1, ['0'])[0]!;

  it('refuses another seller, another Market and a state identity does not allow', async () => {
    const { sellerId, context } = await readySeller();
    const foreign = await contextOf(other, sellerId);

    expect(await submit(foreign)).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(await withdraw(foreign)).toEqual({ ok: false, error: { code: 'file.not-found' } });
    expect(await revisions(sellerId)).toEqual([]);

    await owner.query(
      `UPDATE identity.seller_access SET state = 'suspended' WHERE market_id = $1 AND seller_id = $2`,
      [code, sellerId],
    );
    expect(await submit(context)).toEqual({
      ok: false,
      error: { code: 'seller-access.wrong-state' },
    });
    expect(await revisions(sellerId)).toEqual([]);
  });

  it('refuses an address in an area that no longer takes new sellers, writing nothing', async () => {
    const { sellerId, context } = await readySeller();
    area.open = false;

    expect(await submit(context)).toEqual({
      ok: false,
      error: { code: 'address.outside-service-area' },
    });
    expect(await revisions(sellerId)).toEqual([]);
    expect(await slugRows(sellerId)).toEqual([]);
  });

  it('serves submit, status and withdraw over HTTP with the real use cases', async () => {
    const { sellerId, headers } = await readySeller();
    const http = () => request(app.getHttpServer());

    const submitted = await http().post('/sellers/my-file/submit').set(headers);
    expect(submitted.status).toBe(200);
    expect(submitted.headers['cache-control']).toBe('no-store');
    expect(submitted.body).toMatchObject({ revisionNo: 1, resubmission: false });
    expect(typeof (submitted.body as { submittedAt: string }).submittedAt).toBe('string');

    const read = await http().get('/sellers/my-file').set(headers);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'awaiting-review',
      submission: { revisionNo: 1 },
      latestWithdrawal: null,
    });
    expect((read.body as { onboardingSteps: { state: string }[] }).onboardingSteps).toHaveLength(5);

    const again = await http().post('/sellers/my-file/submit').set(headers);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ statusCode: 409, code: 'file.already-submitted' });

    const withdrawn = await http().post('/sellers/my-file/withdraw').set(headers).send({});
    expect(withdrawn.status).toBe(200);
    const after = await http().get('/sellers/my-file').set(headers);
    expect(after.body).toMatchObject({
      status: 'ready-to-submit',
      submission: null,
      latestWithdrawal: { cause: 'cancelled', byKind: 'seller' },
    });
    const nothing = await http().post('/sellers/my-file/withdraw').set(headers);
    expect(nothing.status).toBe(409);
    expect(await revisions(sellerId)).toHaveLength(1);
  });

  describe('approvedSellerZones (sellers design 7.1a; data design A18)', () => {
    const reader = () => app.get<ApprovedSellerZonesReader>(APPROVED_SELLER_ZONES);
    const system = () => testCallContext(market, 'system', `db-submit-${randomUUID()}`);
    const anonymous = () => testCallContext(market, 'anonymous', `db-submit-${randomUUID()}`);

    /** Makes the seller's pending revision the approved one, the way a decision will (slice 7). */
    async function approve(sellerId: string) {
      const [revision] = await revisions(sellerId);
      await sql.query(
        `UPDATE sellers.business_file_revisions SET status = 'approved', status_changed_at = now(), decided_at = now()
          WHERE market_id = $1 AND id = $2`,
        [code, revision!.id],
      );
      await sql.query(
        'UPDATE sellers.seller_files SET approved_revision_id = $3 WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId, revision!.id],
      );
    }

    it('answers the zones of the approved revision, and nulls for everyone else', async () => {
      const approved = await readySeller();
      await submit(approved.context);
      await approve(approved.sellerId);
      const pending = await readySeller();
      await submit(pending.context);
      const draftOnly = await readySeller();
      // An identity-approved seller with no revision at all (ZZ registers that way) answers null.
      const never = (await signUpSeller()).sellerId;
      const unknown = ids.next<'Seller'>();
      const batch = [never, approved.sellerId, pending.sellerId, draftOnly.sellerId, unknown];

      for (const context of [system(), anonymous()]) {
        const result = await reader().approvedSellerZones(context, batch);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect([...result.value]).toEqual([
          [never, { zone: null, addressZone: null }],
          [approved.sellerId, { zone: FIXTURE.zone, addressZone: FIXTURE.zone }],
          [pending.sellerId, { zone: null, addressZone: null }],
          [draftOnly.sellerId, { zone: null, addressZone: null }],
          [unknown, { zone: null, addressZone: null }],
        ]);
      }
    });

    it('never answers a seller of the other Market', async () => {
      const approved = await readySeller();
      await submit(approved.context);
      await approve(approved.sellerId);

      const elsewhere = await reader().approvedSellerZones(
        testCallContext(marketOf(other), 'system', `db-submit-${randomUUID()}`),
        [approved.sellerId],
      );

      expect(elsewhere.ok && [...elsewhere.value]).toEqual([
        [approved.sellerId, { zone: null, addressZone: null }],
      ]);
    });
  });
});
