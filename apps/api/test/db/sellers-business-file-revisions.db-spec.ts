import { randomUUID } from 'node:crypto';
import { Temporal, ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { ConfiguredLookup } from '../../src/modules/sellers/application/register/register-lookup';
import { registerCheckIsCurrent } from '../../src/modules/sellers/application/register/register-lookup';
import {
  newPendingRevision,
  evaluateSubmission,
  CONTENT_SCHEMA_VERSION,
  type BusinessFileContent,
  type BusinessFileRevision,
} from '../../src/modules/sellers/domain/business-file-revision';
import {
  identifierIndexKeyOf,
  type DraftIdentifier,
} from '../../src/modules/sellers/domain/business-identifier';
import type { Sealed } from '../../src/modules/sellers/domain/sealed';
import { SellerFile, type DraftRequirements } from '../../src/modules/sellers/domain/seller-file';
import type { ShopSlug } from '../../src/modules/sellers/domain/shop-slug';
import { parseStoreName } from '../../src/modules/sellers/domain/store-name';
import { PrismaBusinessFileRevisionRepository } from '../../src/modules/sellers/infrastructure/prisma-business-file-revision.repository';
import { PrismaRegisterCheckRepository } from '../../src/modules/sellers/infrastructure/prisma-register-check.repository';
import { PrismaSellerFileRepository } from '../../src/modules/sellers/infrastructure/prisma-seller-file.repository';
import { SubjectKeyRevisionContentSealer } from '../../src/modules/sellers/infrastructure/subject-key-revision-content-sealer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Sellers slice 5a on PostgreSQL (sellers data design 3.1, 3.2, 3.4, 8, section 22), for both
// Market fixtures, as the application role: the revision table's CHECKs, keys and grants; the
// pointer foreign key; the repository (insert, the refusals that leave the unit usable, the
// reads, the sealed content with a real subject key); and the version binding of register
// results, including the races of Hassan's slice-5 condition that can be tested at repository
// level. The use-case level cases (submit) are listed in section 22 for slice 5b.

const T0 = Temporal.Instant.from('2026-10-08T12:00:00Z');
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;

const FIXTURES = {
  AU: {
    requirements: { identifierRequired: true, identifierScheme: 'abn' } as DraftRequirements,
    area: 'greater-brisbane',
    operatingZone: 'Australia/Lindeman',
    addressZone: 'Australia/Brisbane',
    lookup: {
      kind: 'configured',
      adapter: 'fake',
      maxResultAgeDays: 30,
      perAccountLimit: 5,
      perOriginLimit: 30,
      marketDailyBudget: 1000,
      legalSuffixes: [],
    } satisfies ConfiguredLookup,
    address: { street: '1 Example St', postcode: '4109' },
  },
  ZZ: {
    requirements: {
      identifierRequired: false,
      identifierScheme: 'zz-corp-no',
    } as DraftRequirements,
    area: 'zz-central',
    operatingZone: 'Pacific/Chatham',
    addressZone: 'Pacific/Auckland',
    lookup: {
      kind: 'configured',
      adapter: 'fake',
      maxResultAgeDays: 3,
      perAccountLimit: 2,
      perOriginLimit: 3,
      marketDailyBudget: 50,
      legalSuffixes: [],
    } satisfies ConfiguredLookup,
    address: { line1: 'Test Road 5', code: 'ZZ-77' },
  },
} as const;

/** A well-formed v1 envelope of `length` characters (the shape and bounds the CHECKs ask for). */
const envelope = (length: number): string => `v1.${'A'.repeat(length - 3)}`;
const HASH = (n: number): string => `hmac-sha256:${n.toString(16).padStart(64, '0')}`;

describe.each(TEST_MARKETS)('sellers business file revisions in market %s', (code) => {
  const market = marketOf(code);
  const other = otherMarketOf(code);
  const fixture = FIXTURES[code];
  const clock = new FixedClock(T0);
  // The production generator: v7 ids with random bits, so a fixed clock repeats none (a subject
  // has one key for life, in any Market).
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let files: PrismaSellerFileRepository;
  let revisions: PrismaBusinessFileRevisionRepository;
  let checks: PrismaRegisterCheckRepository;
  let sealer: SubjectKeyRevisionContentSealer;
  let keys: NodeSubjectKeyService;

  beforeAll(async () => {
    db = createPersistence();
    files = new PrismaSellerFileRepository(db.service);
    revisions = new PrismaBusinessFileRevisionRepository(db.service);
    checks = new PrismaRegisterCheckRepository(db.service);
    keys = new NodeSubjectKeyService(
      new PrismaSubjectKeyStore(db.service, db.unitOfWork),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    sealer = new SubjectKeyRevisionContentSealer(keys);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await db.close();
  });

  const inUnit = async <T>(marketCode: string, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(marketOf(marketCode), async () => ok(await work()));
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };

  /** A committed file with its roots (version 1) and a subject key, in `marketCode`. */
  async function newFile(marketCode = code): Promise<Id<'Seller'>> {
    const sellerId = ids.next<'Seller'>();
    const m = marketOf(marketCode);
    await inUnit(marketCode, async () => {
      await keys.createKey(m, sellerId);
      return files.addWithRoots(
        m,
        SellerFile.create({
          sellerId,
          marketId: m.marketId,
          origin: 'self',
          approvalRequiredAtRegistration: true,
          now: T0,
        }),
      );
    });
    return sellerId;
  }

  const identifierOf = (n = 1): DraftIdentifier => ({
    scheme: fixture.requirements.identifierScheme,
    sealed: envelope(60) as Sealed<'identifier'>,
    index: identifierIndexKeyOf(new Uint8Array(32).fill(n)),
  });

  /** Saves an identifier (version 1 to 2) and answers the file as stored. */
  async function withIdentifier(sellerId: Id<'Seller'>, n = 1, at = T0): Promise<SellerFile> {
    return inUnit(code, async () => {
      const file = (await files.findById(market, sellerId))!;
      file.saveIdentifier(identifierOf(n), at, fixture.requirements);
      expect(await files.saveDraft(market, file)).toBe(true);
      return (await files.findById(market, sellerId))!;
    });
  }

  /** A general save (phone, store name, business name): raises the version by one. */
  async function generalSave(sellerId: Id<'Seller'>, at = T0): Promise<boolean> {
    return inUnit(code, async () => {
      const file = (await files.findById(market, sellerId))!;
      const name = parseStoreName('Al Noor');
      if (!name.ok) throw new Error('fixture');
      const saved = file.saveGeneral(
        {
          storeName: name.value,
          businessName: envelope(60) as Sealed<'business-name'>,
          phone: envelope(50) as Sealed<'phone'>,
          contactEmail: null,
        },
        at,
        fixture.requirements,
      );
      if (!saved.ok) throw new Error('fixture');
      return files.saveDraft(market, file);
    });
  }

  const pendingRevision = (
    sellerId: Id<'Seller'>,
    overrides: Partial<Parameters<typeof newPendingRevision>[0]> = {},
  ): BusinessFileRevision =>
    newPendingRevision({
      id: ids.next<'BusinessFileRevision'>(),
      sellerId,
      kind: 'onboarding',
      revisionNo: 1,
      authorKind: 'seller',
      authorAccountId: ACCOUNT,
      snapshot: {
        operatingTimezone: fixture.operatingZone,
        serviceAreaCode: fixture.area,
        addressTimezone: fixture.addressZone,
        identifierIndex: identifierIndexKeyOf(new Uint8Array(32).fill(9)),
      },
      contentHash: HASH(1) as never,
      register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
      now: T0,
      ...overrides,
    });

  const sealedOf = (revision: BusinessFileRevision) => ({
    ciphertext: envelope(80) as never,
    contentHash: revision.contentHash,
  });

  const add = (revision: BusinessFileRevision, marketCode = code) =>
    inUnit(marketCode, () => revisions.add(marketOf(marketCode), revision, sealedOf(revision)));

  // ---- raw rows, for the constraints ----------------------------------------------------

  type Row = Record<string, unknown>;
  /** Inserts one revision row with SQL as the application role; every column can be overridden. */
  function insertRaw(sellerId: string, overrides: Row = {}): Promise<unknown> {
    const row: Row = {
      id: randomUUID(),
      market_id: code,
      tenant_id: market.tenantId,
      seller_id: sellerId,
      kind: 'onboarding',
      revision_no: 1,
      status: 'pending',
      author_kind: 'seller',
      author_account_id: ACCOUNT,
      content_ciphertext: envelope(80),
      content_schema_version: 1,
      content_hash: HASH(1),
      identifier_index: null,
      operating_timezone: fixture.operatingZone,
      service_area_code: fixture.area,
      address_timezone: fixture.addressZone,
      register_outcome: 'not-performed',
      register_mismatches: [],
      register_checked_at: null,
      created_at: T0.toString(),
      status_changed_at: T0.toString(),
      decided_at: null,
      decided_by_account_id: null,
      identity_decision_id: null,
      reject_reason_code: null,
      withdraw_cause: null,
      withdrawn_by_kind: null,
      withdrawn_at: null,
      ...overrides,
    };
    const columns = Object.keys(row);
    return sql.query(
      `INSERT INTO sellers.business_file_revisions (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((column) => row[column]),
    );
  }

  const refuses = async (promise: Promise<unknown>, constraint: string): Promise<void> => {
    await expect(promise).rejects.toMatchObject({ code: '23514', constraint });
  };

  const revisionRows = async (sellerId: string) =>
    (
      await sql.query<{ id: string; status: string }>(
        'SELECT id, status FROM sellers.business_file_revisions WHERE market_id = $1 AND seller_id = $2 ORDER BY revision_no',
        [code, sellerId],
      )
    ).rows;

  describe('the table', () => {
    it('accepts a pending row of each kind and refuses a bad value of every CHECK', async () => {
      const sellerId = await newFile();
      await insertRaw(sellerId);
      await insertRaw(await newFile(), {
        kind: 'identity-change',
        author_kind: 'admin',
        identifier_index: Buffer.alloc(32, 1),
      });
      // Each refused row is a pending row of a file of its own, so only its CHECK can refuse it.
      const c = (name: string) => `business_file_revisions_${name}_check`;
      const bad: [Row, string][] = [
        [{ market_id: 'au' }, c('market_id')],
        [{ tenant_id: 'Default' }, c('tenant_id')],
        [{ kind: 'resubmission' }, c('kind')],
        [{ revision_no: 0 }, c('revision_no')],
        [{ status: 'accepted' }, c('status')],
        [{ author_kind: 'system' }, c('author_kind')],
        [{ content_ciphertext: envelope(40) }, c('content_ciphertext')],
        [{ content_ciphertext: envelope(32769) }, c('content_ciphertext')],
        [{ content_ciphertext: '51824753556'.padEnd(80, '0') }, c('content_ciphertext')],
        [{ content_schema_version: 0 }, c('content_schema_version')],
        [{ content_hash: `sha256:${'a'.repeat(64)}` }, c('content_hash')],
        [{ content_hash: `hmac-sha256:${'A'.repeat(64)}` }, c('content_hash')],
        [{ content_hash: `hmac-sha256:${'a'.repeat(63)}` }, c('content_hash')],
        [{ identifier_index: Buffer.alloc(31) }, c('identifier_index')],
        [{ operating_timezone: '+10:00' }, c('operating_timezone')],
        [{ operating_timezone: 'Europe/A/B/C' }, c('operating_timezone')],
        [{ address_timezone: '+10:00' }, c('address_timezone')],
        [{ service_area_code: 'Greater Brisbane' }, c('service_area_code')],
        [
          { register_outcome: 'verified', register_checked_at: T0.toString() },
          c('register_outcome'),
        ],
        [{ register_mismatches: ['name'] }, c('register_mismatches')],
        [
          {
            register_outcome: 'unavailable',
            register_checked_at: T0.toString(),
            register_mismatches: ['postcode'],
          },
          c('register_mismatches'),
        ],
        [{ register_outcome: 'active' }, c('register_checked_at')],
        [{ register_checked_at: T0.toString() }, c('register_checked_at')],
        [{ status_changed_at: T0.add({ seconds: 1 }).toString() }, c('status_changed_at')],
        [{ decided_at: T0.toString() }, c('decided_at')],
        [{ status: 'approved' }, c('decided_at')],
        [{ decided_by_account_id: ACCOUNT }, c('decided_by_account_id')],
        [
          { identity_decision_id: randomUUID(), kind: 'identity-change' },
          c('identity_decision_id'),
        ],
        [{ reject_reason_code: 'incomplete' }, c('reject_reason_code')],
        [{ withdraw_cause: 'edited' }, c('withdrawn')],
        [
          { withdraw_cause: 'edited', withdrawn_by_kind: 'seller', withdrawn_at: T0.toString() },
          c('withdrawn'),
        ],
        [{ status: 'withdrawn' }, c('withdrawn')],
        [{ status: 'withdrawn', withdraw_cause: 'edited' }, c('withdrawn')],
        [
          {
            status: 'withdrawn',
            withdraw_cause: 'bored',
            withdrawn_by_kind: 'seller',
            withdrawn_at: T0.toString(),
          },
          c('withdraw_cause'),
        ],
        [
          {
            status: 'withdrawn',
            withdraw_cause: 'edited',
            withdrawn_by_kind: 'robot',
            withdrawn_at: T0.toString(),
          },
          c('withdrawn_by_kind'),
        ],
      ];
      for (const [overrides, constraint] of bad) {
        await refuses(insertRaw(await newFile(), overrides), constraint);
      }
      // A NULL mismatch list is refused by the NOT NULL the migration adds.
      await expect(insertRaw(await newFile(), { register_mismatches: null })).rejects.toMatchObject(
        {
          code: '23502',
        },
      );
      expect(await revisionRows(sellerId)).toHaveLength(1);
    });

    it('accepts the boundary values: ciphertext 41 and 32768 characters, mismatches on active, rejected and withdrawn rows', async () => {
      for (const overrides of [
        { content_ciphertext: envelope(41) },
        { content_ciphertext: envelope(32768) },
        { address_timezone: null },
        {
          register_outcome: 'active',
          register_checked_at: T0.toString(),
          register_mismatches: ['postcode', 'business-name'],
        },
        {
          kind: 'identity-change',
          status: 'rejected',
          decided_at: T0.toString(),
          decided_by_account_id: ACCOUNT,
          reject_reason_code: 'business-name-mismatch',
        },
        {
          status: 'withdrawn',
          withdraw_cause: 'reapply-refused',
          withdrawn_by_kind: 'admin',
          withdrawn_at: T0.toString(),
        },
        { status: 'rejected', decided_at: T0.toString(), identity_decision_id: randomUUID() },
      ]) {
        await insertRaw(await newFile(), overrides);
      }
    });

    it('holds one pending revision per file, of either kind, and one live approved revision', async () => {
      const sellerId = await newFile();
      const first = randomUUID();
      await insertRaw(sellerId, { id: first });
      await expect(insertRaw(sellerId, { revision_no: 2 })).rejects.toMatchObject({
        code: '23505',
        constraint: 'business_file_revisions_market_id_seller_id_pending_key',
      });
      await expect(
        insertRaw(sellerId, { revision_no: 2, kind: 'identity-change' }),
      ).rejects.toMatchObject({ code: '23505' });
      // The pointer is empty; the status columns are the only ones the application updates.
      await sql.query(
        `UPDATE sellers.business_file_revisions
            SET status = 'withdrawn', status_changed_at = $3, withdraw_cause = 'edited',
                withdrawn_by_kind = 'seller', withdrawn_at = $3
          WHERE market_id = $1 AND id = $2`,
        [code, first, T0.add({ minutes: 1 }).toString()],
      );
      // A withdrawn revision frees the slot; the revision number is still taken.
      await expect(insertRaw(sellerId, { revision_no: 1 })).rejects.toMatchObject({
        code: '23505',
        constraint: 'business_file_revisions_market_id_seller_id_revision_no_key',
      });
      await insertRaw(sellerId, { revision_no: 2 });
      // Another seller, and the same number in another seller, are unaffected.
      await insertRaw(await newFile(), { revision_no: 2 });

      const approved = { status: 'approved', decided_at: T0.toString() };
      const live = await newFile();
      await insertRaw(live, { ...approved, revision_no: 1 });
      await expect(insertRaw(live, { ...approved, revision_no: 2 })).rejects.toMatchObject({
        code: '23505',
        constraint: 'business_file_revisions_market_id_seller_id_approved_key',
      });
      // A superseded revision keeps the instant it was approved and frees the slot.
      await insertRaw(live, { status: 'superseded', decided_at: T0.toString(), revision_no: 3 });
      expect(await revisionRows(live)).toHaveLength(2);
    });

    it('keys a revision to a file of the same Market, and a pointer only to a revision of that file', async () => {
      const sellerId = await newFile();
      const otherSeller = await newFile();
      await expect(insertRaw(randomUUID())).rejects.toMatchObject({
        code: '23503',
        constraint: 'business_file_revisions_market_id_seller_id_fkey',
      });
      // The right file under the other Market is a missing file.
      await expect(insertRaw(sellerId, { market_id: other })).rejects.toMatchObject({
        code: '23503',
      });

      const own = randomUUID();
      const foreign = randomUUID();
      await insertRaw(sellerId, { id: own, status: 'approved', decided_at: T0.toString() });
      await insertRaw(otherSeller, { id: foreign, status: 'approved', decided_at: T0.toString() });
      const point = (target: string) =>
        sql.query(
          'UPDATE sellers.seller_files SET approved_revision_id = $3 WHERE market_id = $1 AND seller_id = $2',
          [code, sellerId, target],
        );
      await expect(point(foreign)).rejects.toMatchObject({
        code: '23503',
        constraint: 'seller_files_market_id_seller_id_approved_revision_id_fkey',
      });
      await expect(point(randomUUID())).rejects.toMatchObject({ code: '23503' });
      await point(own);
      // RESTRICT: neither the revision nor its file can go from under the pointer or the revision.
      await expect(
        owner.query('DELETE FROM sellers.business_file_revisions WHERE id = $1', [own]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        owner.query('DELETE FROM sellers.seller_files WHERE market_id = $1 AND seller_id = $2', [
          code,
          otherSeller,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('lets the application update the status columns and nothing else, and delete nothing', async () => {
      const sellerId = await newFile();
      const id = randomUUID();
      await insertRaw(sellerId, { id, kind: 'identity-change' });
      await sql.query(
        `UPDATE sellers.business_file_revisions
            SET status = 'rejected', status_changed_at = $3, decided_at = $3,
                decided_by_account_id = $4, reject_reason_code = 'incomplete'
          WHERE market_id = $1 AND id = $2`,
        [code, id, T0.add({ minutes: 2 }).toString(), ACCOUNT],
      );
      for (const column of [
        'content_ciphertext',
        'content_hash',
        'content_schema_version',
        'identifier_index',
        'operating_timezone',
        'service_area_code',
        'address_timezone',
        'register_outcome',
        'register_mismatches',
        'register_checked_at',
        'created_at',
        'revision_no',
        'kind',
        'author_kind',
        'author_account_id',
        'seller_id',
        'market_id',
        'tenant_id',
        'id',
      ]) {
        await expect(
          sql.query(
            `UPDATE sellers.business_file_revisions SET ${column} = ${column} WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
      await expect(
        sql.query('DELETE FROM sellers.business_file_revisions WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('lets the application delete a shop slug (slice 5: a never-public held row is released)', async () => {
      const sellerId = await newFile();
      const slug = `slug-${randomUUID().slice(0, 8)}`;
      await sql.query(
        `INSERT INTO sellers.shop_slugs (id, market_id, tenant_id, slug, seller_id, state, ever_public, held_at, version, created_at)
         VALUES ($1, $2, $3, $4, $5, 'held', false, $6, 1, $6)`,
        [randomUUID(), code, market.tenantId, slug, sellerId, T0.toString()],
      );
      const deleted = await sql.query(
        'DELETE FROM sellers.shop_slugs WHERE market_id = $1 AND slug = $2',
        [code, slug],
      );
      expect(deleted.rowCount).toBe(1);
    });
  });

  describe('PrismaBusinessFileRevisionRepository', () => {
    it('inserts a pending revision and reads it back by every path', async () => {
      const sellerId = await newFile();
      const revision = pendingRevision(sellerId, {
        register: {
          outcome: 'active',
          mismatches: ['postcode'],
          checkedAt: T0.subtract({ hours: 1 }),
        },
      });
      expect(await add(revision)).toEqual({ ok: true, value: undefined });

      const read = (marketCode = code) =>
        inUnit(marketCode, async () => {
          const m = marketOf(marketCode);
          return {
            latest: await revisions.findLatest(m, sellerId),
            pending: await revisions.findPending(m, sellerId),
            approved: await revisions.findApproved(m, sellerId),
            byId: await revisions.findById(m, sellerId, revision.id),
            sealed: await revisions.readSealedContent(m, sellerId, revision.id),
          };
        });
      const stored = await read();
      expect(stored.latest).toEqual(revision);
      expect(stored.pending).toEqual(revision);
      expect(stored.byId).toEqual(revision);
      expect(stored.approved).toBeNull();
      expect(stored.sealed).toBe(envelope(80));
      // The domain value survives the round trip, instants and the keyed index included.
      expect(stored.latest?.register.checkedAt?.epochMilliseconds).toBe(
        T0.subtract({ hours: 1 }).epochMilliseconds,
      );
      expect(stored.latest?.addressTimezone).toBe(fixture.addressZone);
    });

    it('reads nothing of a seller of another Market, exactly like an unknown id', async () => {
      const sellerId = await newFile();
      const revision = pendingRevision(sellerId);
      await add(revision);
      const unknown = ids.next<'Seller'>();
      const seen = await inUnit(other, async () => {
        const m = marketOf(other);
        return [
          await revisions.findLatest(m, sellerId),
          await revisions.findPending(m, sellerId),
          await revisions.findApproved(m, sellerId),
          await revisions.findById(m, sellerId, revision.id),
          await revisions.readSealedContent(m, sellerId, revision.id),
          await revisions.findLatest(m, unknown),
        ];
      });
      expect(seen).toEqual([null, null, null, null, null, null]);
      // A revision id read under another seller of the same Market is also null.
      const second = await newFile();
      expect(await inUnit(code, () => revisions.findById(market, second, revision.id))).toBeNull();
      expect(
        await inUnit(code, () => revisions.readSealedContent(market, second, revision.id)),
      ).toBeNull();
    });

    it('refuses a second pending revision, a taken number and a taken id, and writes nothing', async () => {
      const sellerId = await newFile();
      const first = pendingRevision(sellerId);
      expect((await add(first)).ok).toBe(true);

      // Pending exists (a new number, so only the one-pending key stops it).
      expect(await add(pendingRevision(sellerId, { revisionNo: 2 }))).toEqual({
        ok: false,
        error: { code: 'revision.pending-exists' },
      });
      // The same number is reported as such; the same id as such.
      expect(await add(pendingRevision(sellerId, { revisionNo: 1 }))).toEqual({
        ok: false,
        error: { code: 'revision.number-taken' },
      });
      expect(await add(pendingRevision(sellerId, { id: first.id, revisionNo: 3 }))).toEqual({
        ok: false,
        error: { code: 'revision.id-taken' },
      });
      expect(await revisionRows(sellerId)).toHaveLength(1);

      // A refusal leaves the unit usable: the next statement in the same transaction works.
      const second = pendingRevision(sellerId, { revisionNo: 2 });
      const inOneUnit = await inUnit(code, async () => {
        const refused = await revisions.add(market, second, sealedOf(second));
        return { refused, still: await revisions.findLatest(market, sellerId) };
      });
      expect(inOneUnit.refused).toEqual({ ok: false, error: { code: 'revision.pending-exists' } });
      expect(inOneUnit.still?.id).toBe(first.id);
    });

    it('converges two concurrent submissions on one pending revision', async () => {
      for (let round = 0; round < 3; round += 1) {
        const sellerId = await newFile();
        const results = await Promise.all([
          add(pendingRevision(sellerId, { revisionNo: 1 })),
          add(pendingRevision(sellerId, { revisionNo: 1 })),
          add(pendingRevision(sellerId, { revisionNo: 2 })),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(await revisionRows(sellerId)).toHaveLength(1);
        for (const result of results) {
          if (!result.ok) {
            expect(['revision.number-taken', 'revision.pending-exists']).toContain(
              result.error.code,
            );
          }
        }
      }
    });

    it('refuses a revision that is not pending, or whose hash is not the sealed content hash', async () => {
      const sellerId = await newFile();
      const approved = { ...pendingRevision(sellerId), status: 'approved' as const };
      await expect(add(approved)).rejects.toThrow(RangeError);
      const revision = pendingRevision(sellerId);
      await expect(
        inUnit(code, () =>
          revisions.add(market, revision, {
            ciphertext: envelope(80) as never,
            contentHash: HASH(2) as never,
          }),
        ),
      ).rejects.toThrow(RangeError);
      expect(await revisionRows(sellerId)).toHaveLength(0);
    });

    it('finds the latest by number, the pending one, and the approved one through the pointer', async () => {
      const sellerId = await newFile();
      const first = randomUUID();
      await insertRaw(sellerId, {
        id: first,
        status: 'approved',
        decided_at: T0.toString(),
        revision_no: 1,
      });
      const second = pendingRevision(sellerId, { kind: 'identity-change', revisionNo: 2 });
      expect((await add(second)).ok).toBe(true);

      // No pointer yet: nothing is approved, whatever the status column of a row says.
      expect(await inUnit(code, () => revisions.findApproved(market, sellerId))).toBeNull();
      await sql.query(
        'UPDATE sellers.seller_files SET approved_revision_id = $3 WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId, first],
      );

      const read = await inUnit(code, async () => ({
        latest: await revisions.findLatest(market, sellerId),
        pending: await revisions.findPending(market, sellerId),
        approved: await revisions.findApproved(market, sellerId),
      }));
      expect(read.latest?.id).toBe(second.id);
      expect(read.pending?.id).toBe(second.id);
      expect(read.approved).toMatchObject({ id: first, status: 'approved', revisionNo: 1 });
    });

    it('freezes the draft of a file once its pointer names a revision', async () => {
      const sellerId = await newFile();
      const before = (await inUnit(code, () => files.findById(market, sellerId)))!;
      expect(before.state.hasApprovedRevision).toBe(false);
      expect(before.draftEditable).toBe(true);
      const id = randomUUID();
      await insertRaw(sellerId, { id, status: 'approved', decided_at: T0.toString() });
      await sql.query(
        'UPDATE sellers.seller_files SET approved_revision_id = $3 WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId, id],
      );
      const after = (await inUnit(code, () => files.findById(market, sellerId)))!;
      expect(after.state.hasApprovedRevision).toBe(true);
      expect(after.saveIdentifier(identifierOf(), T0, fixture.requirements)).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
    });

    it('seals the content under the seller key, hashes it with the keyed purpose and opens it only for that seller', async () => {
      const sellerId = await newFile();
      const content: BusinessFileContent = {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        storeName: 'Al Noor',
        businessName: 'Al Noor Trading',
        phone: '+61700000000',
        contactEmail: 'owner@example.test',
        address: { ...fixture.address },
        registeredAddress: null,
        identifier: { scheme: fixture.requirements.identifierScheme, value: 'SECRET-ID-0042' },
        registeredForIndirectTax: false,
      };
      const sealed = await sealer.seal(market, sellerId, content);
      if (!sealed.ok) throw new Error('sealing failed');
      const revision = pendingRevision(sellerId, { contentHash: sealed.value.contentHash });
      expect(await inUnit(code, () => revisions.add(market, revision, sealed.value))).toEqual({
        ok: true,
        value: undefined,
      });

      // The row holds the ciphertext and the keyed hash, and no clear value of the content.
      const stored = await sql.query<{ content_ciphertext: string; content_hash: string }>(
        'SELECT content_ciphertext, content_hash FROM sellers.business_file_revisions WHERE id = $1',
        [revision.id],
      );
      const row = stored.rows[0]!;
      expect(row.content_hash).toBe(sealed.value.contentHash);
      expect(row.content_hash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      for (const secret of [
        'SECRET-ID-0042',
        'owner@example.test',
        '+61700000000',
        'Al Noor Trading',
      ]) {
        expect(row.content_ciphertext).not.toContain(secret);
      }
      const ciphertext = await inUnit(code, () =>
        revisions.readSealedContent(market, sellerId, revision.id),
      );
      expect(ciphertext).toBe(row.content_ciphertext);

      // Opening it and hashing what came out reproduces the recorded hash.
      const opened = await sealer.open(market, sellerId, ciphertext!);
      expect(opened).toEqual({ ok: true, value: content });
      expect(await sealer.hash(market, sellerId, content)).toEqual({
        ok: true,
        value: revision.contentHash,
      });
      // Bound to its seller and Market: a copy to another seller's row does not decrypt.
      const intruder = await newFile();
      await expect(sealer.open(market, intruder, ciphertext!)).rejects.toThrow();
      // And the keyed hash cannot be compared across sellers.
      const hashOther = await sealer.hash(market, intruder, content);
      expect(hashOther.ok && hashOther.value).not.toBe(revision.contentHash);
    });

    it('turns a draft that passes the submission check into the snapshot columns of a revision', async () => {
      const sellerId = await newFile();
      const draft = {
        ...(await inUnit(code, () => files.findById(market, sellerId)))!.state.draft,
        storeName: (() => {
          const name = parseStoreName('Al Noor');
          if (!name.ok) throw new Error('fixture');
          return name.value;
        })(),
        businessName: envelope(60) as Sealed<'business-name'>,
        phone: envelope(50) as Sealed<'phone'>,
        address: envelope(60) as Sealed<'address'>,
        serviceAreaCode: fixture.area,
        zone: {
          operatingTimezone: fixture.operatingZone,
          timezoneSource: 'seller' as const,
          addressTimezone: fixture.addressZone,
        },
        slug: 'al-noor' as ShopSlug,
        identifier: identifierOf(4),
      };
      const snapshot = evaluateSubmission(draft, fixture.requirements, true);
      if (!snapshot.ok) throw new Error('not submittable');
      const revision = pendingRevision(sellerId, { snapshot: snapshot.value });
      expect((await add(revision)).ok).toBe(true);
      const row = (
        await sql.query<{
          operating_timezone: string;
          address_timezone: string;
          service_area_code: string;
          identifier_index: Buffer | null;
        }>(
          'SELECT operating_timezone, address_timezone, service_area_code, identifier_index FROM sellers.business_file_revisions WHERE id = $1',
          [revision.id],
        )
      ).rows[0]!;
      expect(row.operating_timezone).toBe(fixture.operatingZone);
      // The zone derived from the address, never the one the seller chose.
      expect(row.address_timezone).toBe(fixture.addressZone);
      expect(row.address_timezone).not.toBe(row.operating_timezone);
      expect(row.service_area_code).toBe(fixture.area);
      expect(row.identifier_index && [...row.identifier_index]).toEqual(
        Array.from({ length: 32 }, () => 4),
      );
    });
  });

  describe('the register result is bound to the file version it was compared against', () => {
    const by = { kind: 'seller', accountId: ACCOUNT } as const;
    const write = (
      comparedFileVersion: number,
      outcome: 'active' | 'not-found' | 'unavailable' = 'active',
      checkedAt = T0,
    ) => ({ outcome, mismatches: [], checkedAt, checkedBy: by, comparedFileVersion });
    const index = identifierIndexKeyOf(new Uint8Array(32).fill(1));
    const record = (sellerId: Id<'Seller'>, version: number, checkedAt = T0) =>
      inUnit(code, () =>
        checks.record(market, sellerId, index, write(version, 'active', checkedAt)),
      );
    const currentness = async (sellerId: Id<'Seller'>, now = T0): Promise<boolean> =>
      inUnit(code, async () => {
        const file = (await files.findById(market, sellerId))!;
        const check = await checks.find(market, sellerId, index);
        return registerCheckIsCurrent(file, check, now, fixture.lookup);
      });

    it('stores the version, returns it, and replaces it with the latest answer', async () => {
      const sellerId = await newFile();
      const first = await record(sellerId, 2);
      expect(first.comparedFileVersion).toBe(2);
      const second = await record(sellerId, 5);
      expect(second.comparedFileVersion).toBe(5);
      expect(await inUnit(code, () => checks.find(market, sellerId, index))).toEqual(second);
      const raw = await sql.query<{ compared_file_version: number }>(
        'SELECT compared_file_version FROM sellers.register_checks WHERE market_id = $1 AND seller_id = $2',
        [code, sellerId],
      );
      expect(raw.rows).toEqual([{ compared_file_version: 5 }]);
    });

    it('refuses a version below 1, a missing version and a version that is not a whole number', async () => {
      const sellerId = await newFile();
      for (const bad of [0, -3, 1.5, Number.NaN]) {
        await expect(record(sellerId, bad)).rejects.toThrow(RangeError);
      }
      const insert = (version: unknown) =>
        sql.query(
          `INSERT INTO sellers.register_checks (market_id, tenant_id, seller_id, identifier_index, outcome, mismatches, checked_at, checked_by_kind, checked_by_account_id, compared_file_version)
           VALUES ($1, $2, $3, $4, 'active', '{}', $5, 'seller', $6, $7)`,
          [code, market.tenantId, sellerId, Buffer.alloc(32, 7), T0.toString(), ACCOUNT, version],
        );
      await expect(insert(0)).rejects.toMatchObject({
        code: '23514',
        constraint: 'register_checks_compared_file_version_check',
      });
      await expect(insert(-1)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(null)).rejects.toMatchObject({ code: '23502' });
      await insert(1);
    });

    it('is current for the version compared and not current after any edit, even in the same instant', async () => {
      const sellerId = await newFile();
      const file = await withIdentifier(sellerId);
      expect(file.state.version).toBe(2);
      await record(sellerId, file.state.version, file.state.lastChangedAt);
      expect(await currentness(sellerId)).toBe(true);

      // (b) An edit stamped in the same instant as the snapshot: the instants say "current".
      expect(await generalSave(sellerId, T0)).toBe(true);
      const edited = (await inUnit(code, () => files.findById(market, sellerId)))!;
      expect(edited.state.version).toBe(3);
      expect(edited.state.lastChangedAt.epochMilliseconds).toBe(T0.epochMilliseconds);
      const check = await inUnit(code, () => checks.find(market, sellerId, index));
      expect(check?.checkedAt.epochMilliseconds).toBe(edited.state.lastChangedAt.epochMilliseconds);
      expect(await currentness(sellerId)).toBe(false);
    });

    it('is not current when a general save races the write of a no-change identifier lookup (Hassan a)', async () => {
      for (let round = 0; round < 6; round += 1) {
        const sellerId = await newFile();
        const snapshot = await withIdentifier(sellerId);
        // The no-change identifier save changed nothing: its snapshot is the file at version 2.
        const compared = snapshot.state.version;
        const lead = round % 2 === 0;
        const outcomes = await Promise.all([
          lead
            ? record(sellerId, compared, snapshot.state.lastChangedAt)
            : generalSave(sellerId, snapshot.state.lastChangedAt),
          lead
            ? generalSave(sellerId, snapshot.state.lastChangedAt)
            : record(sellerId, compared, snapshot.state.lastChangedAt),
        ]);
        expect(outcomes).toBeDefined();
        const file = (await inUnit(code, () => files.findById(market, sellerId)))!;
        // Whatever the interleaving, the general save committed and no clean active survives.
        expect(file.state.version).toBe(3);
        expect(await currentness(sellerId)).toBe(false);
      }
    });

    it('does not let an edit between the currency check and the submit transition pass (Hassan c)', async () => {
      const sellerId = await newFile();
      const snapshot = await withIdentifier(sellerId);
      await record(sellerId, snapshot.state.version, snapshot.state.lastChangedAt);
      // The submit's currency check, on the file as it read it.
      const beforeEdit = await inUnit(code, async () => ({
        file: (await files.findById(market, sellerId))!,
        check: await checks.find(market, sellerId, index),
      }));
      expect(registerCheckIsCurrent(beforeEdit.file, beforeEdit.check, T0, fixture.lookup)).toBe(
        true,
      );

      // An edit commits before the submit transition.
      expect(await generalSave(sellerId, T0)).toBe(true);

      // The transition, as a version compare-and-set on the file it checked, loses.
      const transition = beforeEdit.file.saveSlug('al-noor' as ShopSlug, T0, fixture.requirements);
      expect(transition.ok).toBe(true);
      expect(await inUnit(code, () => files.saveDraft(market, beforeEdit.file))).toBe(false);
      // And the check, run again on the file as it now is, is not current.
      expect(await currentness(sellerId)).toBe(false);
    });

    it('keeps a definite negative current whatever the version, and never an unavailable result', async () => {
      const sellerId = await newFile();
      await withIdentifier(sellerId);
      await inUnit(code, () => checks.record(market, sellerId, index, write(1, 'not-found')));
      expect(await currentness(sellerId, T0.add({ hours: 24 * 400 }))).toBe(true);
      const other2 = await newFile();
      await withIdentifier(other2);
      await inUnit(code, () => checks.record(market, other2, index, write(2, 'unavailable')));
      expect(await currentness(other2)).toBe(false);
    });
  });

  describe('rate counters of the reviewer notice', () => {
    it('already accepts the kinds of the slice-5 notice and every kind the slice needs', async () => {
      // Slice 2b put all 13 kinds in the CHECK; slice 5a changes none (section 22).
      for (const kind of [
        'submit.file',
        'withdraw.file',
        'reviewer-notice.seller',
        'reviewer-notice.market',
      ]) {
        await sql.query(
          `INSERT INTO sellers.rate_counters (market_id, tenant_id, kind, key_hash, window_started_at, count)
           VALUES ($1, $2, $3, $4, $5, 1)`,
          [
            code,
            market.tenantId,
            kind,
            Buffer.from(randomUUID().replaceAll('-', '').padEnd(64, '0'), 'hex'),
            T0.toString(),
          ],
        );
      }
      await expect(
        sql.query(
          `INSERT INTO sellers.rate_counters (market_id, tenant_id, kind, key_hash, window_started_at, count)
           VALUES ($1, $2, 'reviewer-notice.other', $3, $4, 1)`,
          [code, market.tenantId, Buffer.alloc(32, 3), T0.toString()],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'rate_counters_kind_check' });
    });
  });
});
