import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { PrismaCertificateTypeCatalog } from '../../src/modules/certification/infrastructure/prisma-certificate-type-catalog';
import { PrismaRateCounterRepository } from '../../src/modules/certification/infrastructure/prisma-rate-counter.repository';
import type {
  NewDocument,
  SubmitWrite,
} from '../../src/modules/certification/application/ports/seller-certificate.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Certification migration 3 (seller certificate submit) on PostgreSQL, for both Market fixtures:
// the repository over the real tables (create, T1, draft, files, quota, submit, withdraw, delete),
// the constraints and triggers of the new tables, the foreign keys that bind a file to its
// certificate's seller and type, the insert-only tables and the grants (docs/design/data/
// certification.md 3.4, 3.8 to 3.13, 6.1).

const T0 = Temporal.Instant.from('2026-10-16T00:00:00Z');
const T1 = T0.add({ minutes: 5 });
const ENVELOPE = `v1.${'A'.repeat(48)}`;
const HASH = `hmac-sha256:${'b'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

describe.each(TEST_MARKETS)('certification seller certificates in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let repository: PrismaSellerCertificateRepository;
  let catalog: PrismaCertificateTypeCatalog;
  let counters: PrismaRateCounterRepository;

  const inUnit = <T>(work: () => Promise<T>, m = market): Promise<T> =>
    persistence.unitOfWork
      .run(m, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unexpected refusal');
        return result.value;
      });

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    repository = new PrismaSellerCertificateRepository(persistence.service);
    catalog = new PrismaCertificateTypeCatalog(persistence.service);
    counters = new PrismaRateCounterRepository(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  async function sqlState(client: Client, text: string, values: unknown[] = []) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }
  /** The name of the constraint that refuses a statement, or null. */
  async function constraintOf(text: string, values: unknown[] = []): Promise<string | null> {
    try {
      await sql.query(text, values);
      return null;
    } catch (error) {
      return (
        (error as { constraint?: string }).constraint ?? (error as { code?: string }).code ?? null
      );
    }
  }
  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });
  async function insert(table: string, row: Record<string, unknown>, client = sql) {
    const columns = Object.keys(row);
    await client.query(
      `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  /** A type with a published revision; `requires*` as the form of a third-party certificate. */
  async function type(m = market) {
    const typeId = uuid7();
    const revisionId = uuid7();
    await insert('certification_types', {
      id: typeId,
      ...base(m),
      code: `t${typeId.slice(-12)}`,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T0.toString(),
    });
    // The revision and its texts are one transaction (revision_content_guard_insert).
    await sql.query('BEGIN');
    await insert('certification_type_revisions', {
      id: revisionId,
      ...base(m),
      type_id: typeId,
      revision_no: 1,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      requires_issuer_registry: true,
      requires_document: true,
      requires_expiry: true,
      default_basis: 'SELLER_REQUIRED',
      auto_approve_self_declaration: false,
      badge_icon_key: 'halal',
      author_account_id: uuid7(),
      created_at: T0.toString(),
    });
    await insert('type_revision_texts', {
      ...base(m),
      type_revision_id: revisionId,
      locale: 'en',
      name: 'Halal',
      customer_description: 'Halal certified',
    });
    await sql.query('COMMIT');
    await sql.query(
      `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
      [revisionId, typeId],
    );
    return { typeId, revisionId };
  }

  async function issuer(typeId: string, state = 'active', m = market) {
    const id = uuid7();
    await insert('issuers', {
      id,
      ...base(m),
      type_id: typeId,
      display_name: 'Halal Authority',
      display_name_key: `issuer ${id}`,
      accreditation_number: null,
      state,
      expert_reference_ciphertext: ENVELOPE,
      state_changed_at: T0.toString(),
      state_changed_by_kind: 'seed',
      state_changed_by_account_id: null,
      version: 1,
      created_at: T0.toString(),
    });
    return id;
  }

  const newCertificate = async (sellerId: string, typeId: string) => {
    const id = uuid7() as Id<'SellerCertification'>;
    const refusal = await inUnit(() =>
      repository.add(market, {
        id,
        sellerId: sellerId as Id<'Seller'>,
        typeId: typeId as Id<'CertificationType'>,
        now: T0,
      }),
    );
    return { id, refusal };
  };

  const documentOf = (
    certificateId: Id<'SellerCertification'>,
    sellerId: string,
    typeId: string,
    expectedVersion: number,
    overrides: Partial<NewDocument> = {},
  ): NewDocument => {
    const id = uuid7() as Id<'UploadedDocument'>;
    return {
      id,
      certificateId,
      expectedVersion,
      sellerId: sellerId as Id<'Seller'>,
      typeId: typeId as Id<'CertificationType'>,
      position: 1,
      mediaType: 'application/pdf',
      byteSize: 1000,
      pageCount: 1,
      objectKey: `certification/${sellerId}/${id}`,
      dataKeyEnvelope: ENVELOPE,
      cleanSha256: sha(id),
      indexHmac: new Uint8Array(32).fill(7),
      now: T0,
      ...overrides,
    };
  };

  const addDocument = (document: NewDocument) =>
    inUnit(() => repository.addDocument(market, document));

  describe('the repository over the real tables', () => {
    it('creates a draft, refuses a second open one of the type (T1) and keeps sellers apart', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const first = await newCertificate(seller, typeId);
      expect(first.refusal).toBeNull();
      expect((await newCertificate(seller, typeId)).refusal).toBe('certificate.exists');
      expect((await newCertificate(uuid7(), typeId)).refusal).toBeNull();

      const stored = await inUnit(() =>
        repository.findOwn(market, seller as Id<'Seller'>, first.id),
      );
      expect(stored).toMatchObject({
        id: first.id,
        status: 'draft',
        version: 1,
        submissionCount: 0,
        pendingSubmissionId: null,
        draft: { issuerId: null, issueDate: null },
      });
      expect(stored!.typeCode).toMatch(/^t/);
      // Another seller, and another Market, see the same absence as an unknown id.
      await expect(
        inUnit(() => repository.findOwn(market, uuid7() as Id<'Seller'>, first.id)),
      ).resolves.toBeNull();
      await expect(
        inUnit(() => repository.findOwn(other, seller as Id<'Seller'>, first.id), other),
      ).resolves.toBeNull();
    });

    it('frees the slot of a declined certificate, as the open index says', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const first = await newCertificate(seller, typeId);
      await sql.query(
        `UPDATE certification.seller_certifications SET status = 'declined' WHERE id = $1`,
        [first.id],
      );
      expect((await newCertificate(seller, typeId)).refusal).toBeNull();
    });

    it('saves the draft with its dates as local dates, and refuses a stale version', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const issuerId = (await issuer(typeId)) as Id<'Issuer'>;
      await inUnit(() =>
        repository.saveDraft(
          market,
          id,
          1,
          {
            issuerId,
            certificateNumberCiphertext: ENVELOPE,
            issueDate: Temporal.PlainDate.from('2026-01-31'),
            expiryDate: Temporal.PlainDate.from('2027-12-31'),
            selfDeclared: null,
            selfDeclarationNoteCiphertext: null,
          },
          T1,
        ),
      );
      const stored = await inUnit(() => repository.findOwn(market, seller as Id<'Seller'>, id));
      expect(stored).toMatchObject({ version: 2 });
      expect(stored!.draft.issuerId).toBe(issuerId);
      expect(stored!.draft.issueDate!.toString()).toBe('2026-01-31');
      expect(stored!.draft.expiryDate!.toString()).toBe('2027-12-31');
      expect(stored!.lastChangedAt.toString()).toBe(T1.toString());

      await expect(
        inUnit(() => repository.saveDraft(market, id, 1, stored!.draft, T1)),
      ).rejects.toBeInstanceOf(StaleAggregateError);
    });

    it('refuses an issuer of another type as the draft issuer (AC 11)', async () => {
      const mine = await type();
      const theirs = await type();
      const wrong = await issuer(theirs.typeId);
      const seller = uuid7();
      const { id } = await newCertificate(seller, mine.typeId);
      expect(
        await sqlState(
          sql,
          `UPDATE certification.seller_certifications SET draft_issuer_id = $1 WHERE id = $2`,
          [wrong, id],
        ),
      ).toBe('23503');
    });

    it("lists the seller's certificates newest first, page by page", async () => {
      const seller = uuid7();
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { typeId } = await type();
        const created = uuid7() as Id<'SellerCertification'>;
        await inUnit(() =>
          repository.add(market, {
            id: created,
            sellerId: seller as Id<'Seller'>,
            typeId: typeId as Id<'CertificationType'>,
            now: T0.add({ minutes: i }),
          }),
        );
        ids.push(created);
      }
      const first = await inUnit(() =>
        repository.listOwn(market, seller as Id<'Seller'>, { afterId: null, limit: 2 }),
      );
      expect(first.map((c) => c.id)).toEqual([ids[2], ids[1]]);
      const second = await inUnit(() =>
        repository.listOwn(market, seller as Id<'Seller'>, {
          afterId: first[1]!.id,
          limit: 2,
        }),
      );
      expect(second.map((c) => c.id)).toEqual([ids[0]]);
    });

    it('reads the registry: a type by code and id, its active issuers, the active types', async () => {
      const { typeId, revisionId } = await type();
      const active = await issuer(typeId, 'active');
      await issuer(typeId, 'derecognised');
      const [byId, issuers, all] = await inUnit(
        async () =>
          [
            await catalog.typeById(market, typeId as Id<'CertificationType'>),
            await catalog.activeIssuers(market, typeId as Id<'CertificationType'>),
            await catalog.activeTypes(market),
          ] as const,
      );
      expect(byId).toMatchObject({
        typeId,
        revisionId,
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresIssuerRegistry: true,
        requiresDocument: true,
        requiresExpiry: true,
      });
      expect(issuers.map((i) => i.id)).toEqual([active]);
      expect(all.some((t) => t.typeId === typeId && t.names['en'] === 'Halal')).toBe(true);
      await expect(
        inUnit(() => catalog.typeById(other, typeId as Id<'CertificationType'>), other),
      ).resolves.toBeNull();
      expect(await inUnit(() => catalog.issuer(market, active as Id<'Issuer'>))).toMatchObject({
        state: 'active',
        typeId,
      });
    });
  });

  describe('files and the draft quota', () => {
    it('adds files in order, moves the version, and lists them with their place', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const one = documentOf(id, seller, typeId, 1, { position: 1 });
      const two = documentOf(id, seller, typeId, 2, {
        position: 2,
        mediaType: 'image/png',
        pageCount: null,
      });
      await addDocument(one);
      await addDocument(two);
      const listed = await inUnit(() => repository.listDocuments(market, id));
      expect(listed.map((d) => [d.id, d.position, d.mediaType, d.submitted])).toEqual([
        [one.id, 1, 'application/pdf', false],
        [two.id, 2, 'image/png', false],
      ]);
      expect(listed[0]!.cleanSha256.equals(one.cleanSha256)).toBe(true);
      expect(listed[0]!.byteSize).toBe(1000);
      const stored = await inUnit(() => repository.findOwn(market, seller as Id<'Seller'>, id));
      expect(stored!.version).toBe(3);
      // A stale writer is refused and leaves no file behind.
      const late = documentOf(id, seller, typeId, 1);
      await expect(addDocument(late)).rejects.toBeInstanceOf(StaleAggregateError);
      expect(
        (await sql.query(`SELECT 1 FROM certification.uploaded_documents WHERE id = $1`, [late.id]))
          .rowCount,
      ).toBe(0);
    });

    it('binds a file to the seller and the type of its certificate', async () => {
      const mine = await type();
      const theirs = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, mine.typeId);
      const document = documentOf(id, seller, mine.typeId, 1);
      await addDocument(document);
      // A file owned by another seller cannot be linked to this draft.
      const foreign = uuid7();
      await insert('uploaded_documents', {
        id: foreign,
        ...base(),
        owner_seller_id: uuid7(),
        purpose: 'seller-certificate',
        type_id: mine.typeId,
        state: 'clean',
        media_type: 'application/pdf',
        byte_size: 10,
        page_count: 1,
        data_key_envelope: ENVELOPE,
        object_key: `certification/x/${foreign}`,
        clean_sha256: sha(foreign),
        version: 1,
        created_at: T0.toString(),
      });
      expect(
        await constraintOf(
          `INSERT INTO certification.seller_certification_draft_documents
             (market_id, tenant_id, seller_certification_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, 2)`,
          [market.marketId, market.tenantId, id, mine.typeId, seller, foreign],
        ),
      ).toBe('seller_certification_draft_documents_market_id_document_id_fkey');
      // A file of another type cannot be linked to a certificate of this type.
      const wrongType = uuid7();
      await insert('uploaded_documents', {
        id: wrongType,
        ...base(),
        owner_seller_id: seller,
        purpose: 'seller-certificate',
        type_id: theirs.typeId,
        state: 'clean',
        media_type: 'application/pdf',
        byte_size: 10,
        page_count: 1,
        data_key_envelope: ENVELOPE,
        object_key: `certification/x/${wrongType}`,
        clean_sha256: sha(wrongType),
        version: 1,
        created_at: T0.toString(),
      });
      expect(
        await constraintOf(
          `INSERT INTO certification.seller_certification_draft_documents
             (market_id, tenant_id, seller_certification_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, 2)`,
          [market.marketId, market.tenantId, id, mine.typeId, seller, wrongType],
        ),
      ).toBe('seller_certification_draft_documents_market_id_document_id_fkey');
      // A file belongs to at most one draft.
      const second = await newCertificate(seller, theirs.typeId);
      expect(
        await sqlState(
          sql,
          `INSERT INTO certification.seller_certification_draft_documents
             (market_id, tenant_id, seller_certification_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [market.marketId, market.tenantId, second.id, theirs.typeId, seller, wrongType],
        ),
      ).toBeNull();
    });

    it('links only a clean file (the received state has none)', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const pending = uuid7();
      await insert('uploaded_documents', {
        id: pending,
        ...base(),
        owner_seller_id: seller,
        purpose: 'seller-certificate',
        type_id: typeId,
        state: 'received',
        byte_size: 10,
        data_key_envelope: ENVELOPE,
        object_key: `certification/x/${pending}`,
        version: 1,
        created_at: T0.toString(),
      });
      expect(
        await sqlState(
          sql,
          `INSERT INTO certification.seller_certification_draft_documents
             (market_id, tenant_id, seller_certification_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [market.marketId, market.tenantId, id, typeId, seller, pending],
        ),
      ).toBe('23514');
    });

    it('links only a file made for a seller certificate (purpose), at the draft and at the submission', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const other = uuid7();
      await insert('uploaded_documents', {
        id: other,
        ...base(),
        owner_seller_id: seller,
        purpose: 'issuer-request',
        type_id: typeId,
        state: 'clean',
        media_type: 'application/pdf',
        byte_size: 10,
        page_count: 1,
        data_key_envelope: ENVELOPE,
        object_key: `certification/x/${other}`,
        clean_sha256: sha(other),
        version: 1,
        created_at: T0.toString(),
      });
      expect(
        await sqlState(
          sql,
          `INSERT INTO certification.seller_certification_draft_documents
             (market_id, tenant_id, seller_certification_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [market.marketId, market.tenantId, id, typeId, seller, other],
        ),
      ).toBe('23514');
    });

    it('keeps the draft order unique: two files cannot take one position', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      await addDocument(documentOf(id, seller, typeId, 1));
      const second = documentOf(id, seller, typeId, 1);
      await expect(addDocument(second)).rejects.toThrow();
    });

    it('names the constraint that refuses a malformed file row', async () => {
      const { typeId } = await type();
      const valid = () => {
        const id = uuid7();
        return {
          id,
          ...base(),
          owner_seller_id: uuid7(),
          purpose: 'seller-certificate',
          type_id: typeId,
          state: 'clean',
          media_type: 'application/pdf',
          byte_size: 100,
          page_count: 1,
          data_key_envelope: ENVELOPE,
          object_key: `certification/s/${id}`,
          clean_sha256: sha(id),
          version: 1,
          created_at: T0.toString(),
        } as Record<string, unknown>;
      };
      const cases: [Record<string, unknown>, string][] = [
        [{ byte_size: 0 }, 'uploaded_documents_byte_size_check'],
        [{ byte_size: 33554433 }, 'uploaded_documents_byte_size_check'],
        [{ page_count: 51 }, 'uploaded_documents_page_count_check'],
        [{ media_type: 'text/html' }, 'uploaded_documents_media_type_check'],
        [{ state: 'quarantined', clean_sha256: null }, 'uploaded_documents_state_check'],
        [{ state: 'received' }, 'uploaded_documents_clean_pair_check'],
        [{ clean_sha256: null }, 'uploaded_documents_clean_pair_check'],
        [{ clean_sha256: Buffer.alloc(31) }, 'uploaded_documents_clean_sha256_check'],
        [{ object_key: 'evidence/x' }, 'uploaded_documents_object_key_check'],
        [{ data_key_envelope: 'plain' }, 'uploaded_documents_data_key_envelope_check'],
        [{ purpose: 'selfie' }, 'uploaded_documents_purpose_check'],
        [{ owner_seller_id: null }, 'uploaded_documents_owner_purpose_check'],
        [{ version: 0 }, 'uploaded_documents_version_check'],
        [{ market_id: 'au' }, 'uploaded_documents_market_id_check'],
      ];
      for (const [overrides, constraint] of cases) {
        const row = { ...valid(), ...overrides };
        const columns = Object.keys(row);
        expect({
          overrides,
          constraint: await constraintOf(
            `INSERT INTO certification.uploaded_documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
            Object.values(row),
          ),
        }).toEqual({ overrides, constraint });
      }
    });

    it('keeps the identity of a file fixed: the owner cannot change it, the application cannot update', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const document = documentOf(id, seller, typeId, 1);
      await addDocument(document);
      expect(
        await sqlState(
          sql,
          `UPDATE certification.uploaded_documents SET byte_size = 5 WHERE id = $1`,
          [document.id],
        ),
      ).toBe('42501');
      for (const column of [
        'byte_size = 5',
        `object_key = 'certification/z'`,
        `owner_seller_id = '${uuid7()}'`,
      ]) {
        expect(
          await sqlState(
            owner,
            `UPDATE certification.uploaded_documents SET ${column} WHERE id = $1`,
            [document.id],
          ),
        ).toBe('23001');
      }
    });

    it('reserves the draft quota with one guarded statement: two racing uploads cannot both pass', async () => {
      const seller = uuid7() as Id<'Seller'>;
      const limit = 100;
      const results = await Promise.all([
        inUnit(() => repository.reserveQuota(market, seller, 60, limit, T0)),
        inUnit(() => repository.reserveQuota(market, seller, 60, limit, T0)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        (
          await sql.query(
            `SELECT draft_bytes::int AS n FROM certification.seller_draft_quotas WHERE seller_id = $1`,
            [seller],
          )
        ).rows[0],
      ).toEqual({ n: 60 });
      await expect(
        inUnit(() => repository.reserveQuota(market, seller, 40, limit, T0)),
      ).resolves.toBe(true);
      await expect(
        inUnit(() => repository.reserveQuota(market, seller, 1, limit, T0)),
      ).resolves.toBe(false);
      await expect(
        inUnit(() => repository.reserveQuota(market, seller, 101, limit, T0)),
      ).resolves.toBe(false);
      await inUnit(() => repository.releaseQuota(market, seller, 30, T1));
      await inUnit(() => repository.releaseQuota(market, seller, 500, T1));
      expect(
        (
          await sql.query(
            `SELECT draft_bytes::int AS n FROM certification.seller_draft_quotas WHERE seller_id = $1`,
            [seller],
          )
        ).rows[0],
      ).toEqual({ n: 0 });
      expect(
        await constraintOf(
          `UPDATE certification.seller_draft_quotas SET draft_bytes = -1 WHERE seller_id = $1`,
          [seller],
        ),
      ).toBe('seller_draft_quotas_draft_bytes_check');
    });

    it('counts rate attempts per key, restarts an ended window and keeps Markets apart', async () => {
      const keyHash = new Uint8Array(sha(uuid7()));
      const limit = { kind: 'upload.seller.day' as const, limit: 2, windowMinutes: 60 };
      const reserve = (m = market, at = T0) =>
        inUnit(() => counters.reserve(m, [{ limit, keyHash }], at), m);
      expect((await reserve())[0]!.count).toBe(1);
      expect((await reserve())[0]!.count).toBe(2);
      expect((await reserve(other))[0]!.count).toBe(1);
      expect((await reserve(market, T0.add({ minutes: 30 })))[0]!.count).toBe(3);
      const restarted = (await reserve(market, T0.add({ minutes: 61 })))[0]!;
      expect(restarted.count).toBe(1);
      expect(restarted.windowStartedAt.toString()).toBe(T0.add({ minutes: 61 }).toString());
      expect(
        await sqlState(
          sql,
          `INSERT INTO certification.rate_counters (market_id, tenant_id, kind, key_hash, window_started_at, count)
           VALUES ($1, $2, 'made-up', $3, $4, 1)`,
          [market.marketId, market.tenantId, Buffer.from(keyHash), T0.toString()],
        ),
      ).toBe('23514');
    });

    it('removes a file nothing holds with its row, and refuses a stale remover', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const document = documentOf(id, seller, typeId, 1);
      await addDocument(document);
      await expect(
        inUnit(() => repository.removeDocument(market, id, document.id, 1, T1)),
      ).rejects.toBeInstanceOf(StaleAggregateError);
      await expect(
        inUnit(() => repository.removeDocument(market, id, document.id, 2, T1)),
      ).resolves.toBe('deleted');
      expect(
        (
          await sql.query(`SELECT 1 FROM certification.uploaded_documents WHERE id = $1`, [
            document.id,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        inUnit(() => repository.removeDocument(market, id, document.id, 3, T1)),
      ).resolves.toBe('missing');
    });
  });

  describe('submit, withdraw and delete', () => {
    async function readyToSubmit() {
      const { typeId, revisionId } = await type();
      const issuerId = await issuer(typeId);
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const document = documentOf(id, seller, typeId, 1);
      await addDocument(document);
      const write: SubmitWrite = {
        certificateId: id,
        expectedVersion: 2,
        sellerId: seller as Id<'Seller'>,
        typeId: typeId as Id<'CertificationType'>,
        typeRevisionId: revisionId as Id<'CertificationTypeRevision'>,
        submissionId: uuid7() as Id<'Submission'>,
        submissionNo: 1,
        kind: 'initial',
        issuerId: issuerId as Id<'Issuer'>,
        certificateNumberCiphertext: ENVELOPE,
        issueDate: Temporal.PlainDate.from('2026-01-01'),
        expiryDate: Temporal.PlainDate.from('2027-12-31'),
        selfDeclared: null,
        selfDeclarationNoteCiphertext: null,
        contentSchemaVersion: 1,
        contentHash: HASH,
        submittedZone: 'Australia/Brisbane',
        submittedAt: T1,
        submittedByAccountId: uuid7() as Id<'Account'>,
        documentIds: [document.id],
        fromStatus: 'draft',
        toStatus: 'in-review',
        numberIndexHmac: null,
        historyId: uuid7() as Id<'CertificationHistory'>,
      };
      return { typeId, seller, id, document, write };
    }

    it('writes the submission, its files, the root and the history in one unit', async () => {
      const { seller, id, document, write } = await readyToSubmit();
      await inUnit(() => repository.submit(market, write));

      const stored = await inUnit(() => repository.findOwn(market, seller as Id<'Seller'>, id));
      expect(stored).toMatchObject({
        status: 'in-review',
        pendingSubmissionId: write.submissionId,
        pendingKind: 'initial',
        submissionCount: 1,
        version: 3,
      });
      expect(stored!.statusChangedAt.toString()).toBe(T1.toString());
      const rows = await sql.query(
        `SELECT s.submission_no, s.kind, s.issuer_id, s.issue_date::text AS issue_date,
                s.expiry_date::text AS expiry_date, s.content_hash,
                (SELECT count(*)::int FROM certification.seller_submission_documents d WHERE d.submission_id = s.id) AS files,
                (SELECT count(*)::int FROM certification.seller_certification_history h WHERE h.submission_id = s.id) AS history
           FROM certification.seller_certification_submissions s WHERE s.id = $1`,
        [write.submissionId],
      );
      expect(rows.rows[0]).toEqual({
        submission_no: 1,
        kind: 'initial',
        issuer_id: write.issuerId,
        issue_date: '2026-01-01',
        expiry_date: '2027-12-31',
        content_hash: HASH,
        files: 1,
        history: 1,
      });
      expect(
        (
          await sql.query(
            `SELECT from_status, to_status, actor_kind FROM certification.seller_certification_history WHERE id = $1`,
            [write.historyId],
          )
        ).rows[0],
      ).toEqual({ from_status: 'draft', to_status: 'in-review', actor_kind: 'seller' });

      // The submitted file stays when it leaves the draft, and is still readable by its owner.
      const listed = await inUnit(() => repository.listDocuments(market, id));
      expect(listed.map((d) => d.submitted)).toEqual([true]);
      await expect(
        inUnit(() => repository.removeDocument(market, id, document.id, 3, T1)),
      ).resolves.toBe('unlinked');
      expect(
        (
          await sql.query(`SELECT 1 FROM certification.uploaded_documents WHERE id = $1`, [
            document.id,
          ])
        ).rowCount,
      ).toBe(1);
      const readable = await inUnit(() =>
        repository.findDocumentForRead(market, seller as Id<'Seller'>, id, document.id),
      );
      expect(readable).toMatchObject({ id: document.id, submitted: true });
      await expect(
        inUnit(() =>
          repository.findDocumentForRead(market, uuid7() as Id<'Seller'>, id, document.id),
        ),
      ).resolves.toBeNull();
      await expect(
        inUnit(() =>
          repository.findDocumentForRead(
            market,
            seller as Id<'Seller'>,
            id,
            uuid7() as Id<'UploadedDocument'>,
          ),
        ),
      ).resolves.toBeNull();
    });

    it('rolls the whole unit back when the version is stale', async () => {
      const { id, write } = await readyToSubmit();
      await expect(
        inUnit(() => repository.submit(market, { ...write, expectedVersion: 1 })),
      ).rejects.toBeInstanceOf(StaleAggregateError);
      for (const table of ['seller_certification_submissions', 'seller_certification_history']) {
        expect(
          (
            await sql.query(
              `SELECT 1 FROM certification.${table} WHERE seller_certification_id = $1`,
              [id],
            )
          ).rowCount,
        ).toBe(0);
      }
      expect(
        (
          await sql.query(
            `SELECT status, pending_submission_id FROM certification.seller_certifications WHERE id = $1`,
            [id],
          )
        ).rows[0],
      ).toEqual({ status: 'draft', pending_submission_id: null });
    });

    it('withdraws the pending submission: the decision, the history, the status back to draft', async () => {
      const { seller, id, write } = await readyToSubmit();
      await inUnit(() => repository.submit(market, write));
      const historyId = uuid7() as Id<'CertificationHistory'>;
      const accountId = uuid7() as Id<'Account'>;
      await inUnit(() =>
        repository.withdraw(market, {
          certificateId: id,
          expectedVersion: 3,
          submissionId: write.submissionId,
          cause: 'cancelled',
          accountId,
          decidedAt: T1.add({ minutes: 1 }),
          fromStatus: 'in-review',
          toStatus: 'draft',
          historyId,
        }),
      );
      const stored = await inUnit(() => repository.findOwn(market, seller as Id<'Seller'>, id));
      expect(stored).toMatchObject({ status: 'draft', pendingSubmissionId: null, version: 4 });
      expect(
        (
          await sql.query(
            `SELECT outcome, withdraw_cause, actor_kind FROM certification.seller_submission_decisions WHERE submission_id = $1`,
            [write.submissionId],
          )
        ).rows[0],
      ).toEqual({ outcome: 'withdrawn', withdraw_cause: 'cancelled', actor_kind: 'seller' });
      expect(
        (
          await sql.query(
            `SELECT from_status, to_status, reason_code FROM certification.seller_certification_history WHERE id = $1`,
            [historyId],
          )
        ).rows[0],
      ).toEqual({ from_status: 'in-review', to_status: 'draft', reason_code: 'cancelled' });
      // A second withdrawal of the same submission is refused by the one-outcome key.
      await expect(
        inUnit(() =>
          repository.withdraw(market, {
            certificateId: id,
            expectedVersion: 4,
            submissionId: write.submissionId,
            cause: 'cancelled',
            accountId,
            decidedAt: T1,
            fromStatus: 'draft',
            toStatus: 'draft',
            historyId: uuid7() as Id<'CertificationHistory'>,
          }),
        ),
      ).rejects.toThrow();
    });

    it('deletes a record that never had a submission, with its files, and nothing else', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      const document = documentOf(id, seller, typeId, 1);
      await addDocument(document);
      await expect(
        inUnit(() => repository.deleteNeverSubmitted(market, uuid7() as Id<'Seller'>, id)),
      ).resolves.toBe(false);
      await expect(
        inUnit(() => repository.deleteNeverSubmitted(market, seller as Id<'Seller'>, id)),
      ).resolves.toBe(true);
      for (const [table, column] of [
        ['seller_certifications', 'id'],
        ['uploaded_documents', 'id'],
        ['seller_certification_draft_documents', 'seller_certification_id'],
      ] as const) {
        expect(
          (
            await sql.query(`SELECT 1 FROM certification.${table} WHERE ${column} = $1`, [
              column === 'id' && table === 'uploaded_documents' ? document.id : id,
            ])
          ).rowCount,
        ).toBe(0);
      }
    });

    it('does not delete a record that had a submission', async () => {
      const { seller, id, write } = await readyToSubmit();
      await inUnit(() => repository.submit(market, write));
      await expect(
        inUnit(() => repository.deleteNeverSubmitted(market, seller as Id<'Seller'>, id)),
      ).resolves.toBe(false);
      expect(
        await sqlState(sql, `DELETE FROM certification.seller_certifications WHERE id = $1`, [id]),
      ).toBe('23503');
    });

    it('keeps submission files and history insert-only: 42501 for the application, 23001 for the owner', async () => {
      const { id, write } = await readyToSubmit();
      await inUnit(() => repository.submit(market, write));
      const statements = [
        `UPDATE certification.seller_submission_documents SET position = 9 WHERE submission_id = $1`,
        `DELETE FROM certification.seller_submission_documents WHERE submission_id = $1`,
      ];
      for (const statement of statements) {
        expect(await sqlState(sql, statement, [write.submissionId])).toBe('42501');
        expect(await sqlState(owner, statement, [write.submissionId])).toBe('23001');
      }
      for (const statement of [
        `UPDATE certification.seller_certification_history SET to_status = 'approved' WHERE seller_certification_id = $1`,
        `DELETE FROM certification.seller_certification_history WHERE seller_certification_id = $1`,
      ]) {
        expect(await sqlState(sql, statement, [id])).toBe('42501');
        expect(await sqlState(owner, statement, [id])).toBe('23001');
      }
      expect(await sqlState(sql, `TRUNCATE certification.seller_certification_history`)).toBe(
        '42501',
      );
      expect(await sqlState(owner, `TRUNCATE certification.seller_submission_documents`)).toBe(
        '23001',
      );
      expect(await sqlState(owner, `TRUNCATE certification.seller_certification_history`)).toBe(
        '23001',
      );
    });

    it('binds a submission file to the submission seller and type, whatever the caller writes', async () => {
      const { seller, write } = await readyToSubmit();
      await inUnit(() => repository.submit(market, write));
      const foreign = uuid7();
      const foreignSeller = uuid7();
      await insert('uploaded_documents', {
        id: foreign,
        ...base(),
        owner_seller_id: foreignSeller,
        purpose: 'seller-certificate',
        type_id: write.typeId,
        state: 'clean',
        media_type: 'application/pdf',
        byte_size: 10,
        page_count: 1,
        data_key_envelope: ENVELOPE,
        object_key: `certification/x/${foreign}`,
        clean_sha256: sha(foreign),
        version: 1,
        created_at: T0.toString(),
      });
      const link = `INSERT INTO certification.seller_submission_documents
             (market_id, tenant_id, submission_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, 2)`;
      // Another seller's file under this submission's seller: the file's own key refuses it.
      expect(
        await constraintOf(link, [
          market.marketId,
          market.tenantId,
          write.submissionId,
          write.typeId,
          seller,
          foreign,
        ]),
      ).toBe('seller_submission_documents_document_fkey');
      // The same file under its own owner: the submission's key refuses it.
      expect(
        await constraintOf(link, [
          market.marketId,
          market.tenantId,
          write.submissionId,
          write.typeId,
          foreignSeller,
          foreign,
        ]),
      ).toBe('seller_submission_documents_submission_fkey');
    });

    it('refuses rows of another Market on the new tables', async () => {
      const { typeId } = await type();
      const seller = uuid7();
      const { id } = await newCertificate(seller, typeId);
      expect(
        await sqlState(
          sql,
          `INSERT INTO certification.seller_certification_history
             (id, market_id, tenant_id, seller_certification_id, to_status, actor_kind, actor_account_id, occurred_at)
           VALUES ($1, $2, $3, $4, 'draft', 'seller', $5, $6)`,
          [uuid7(), other.marketId, other.tenantId, id, uuid7(), T0.toString()],
        ),
      ).toBe('23503');
    });
  });
});
