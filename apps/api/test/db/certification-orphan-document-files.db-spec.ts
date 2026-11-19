import { createHash } from 'node:crypto';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaOrphanDocumentFilesRepository } from '../../src/modules/certification/infrastructure/prisma-orphan-document-files.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The certificate file sweep's query (file storage pilot F6c) on PostgreSQL, for both Market
// fixtures. It is the only Market-isolation control of the sweep: a key comes back only when no
// uploaded-document row of this Market names it AND its subject is a seller with a certificate in
// this Market or this Market's platform subject. Another Market's files, even in a shared store,
// never come back.

const ENVELOPE = `v1.${'A'.repeat(48)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sha = (text: string): Buffer => createHash('sha256').update(text).digest();
const keyOf = (subject: string, document: string) => `certification/${subject}/${document}`;

describe.each(TEST_MARKETS)('orphan certificate file query in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let sellerSide: PrismaSellerCertificateRepository;
  let files: PrismaOrphanDocumentFilesRepository;

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    sellerSide = new PrismaSellerCertificateRepository(persistence.service);
    files = new PrismaOrphanDocumentFilesRepository(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }
  const base = (m = market) => ({ market_id: m.marketId, tenant_id: m.tenantId });

  async function typeIn(m = market): Promise<Id<'CertificationType'>> {
    const typeId = uuid7();
    const revisionId = uuid7();
    const T = '2019-01-01T00:00:00Z';
    await insert('certification_types', {
      id: typeId,
      ...base(m),
      code: `t${typeId.slice(-12)}`,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T,
    });
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
      created_at: T,
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
    return typeId as Id<'CertificationType'>;
  }

  /** A seller with a draft certificate and one stored document in the given Market. */
  async function sellerWithDocument(m = market) {
    const typeId = await typeIn(m);
    const sellerId = uuid7() as Id<'Seller'>;
    const certificateId = uuid7() as Id<'SellerCertification'>;
    const documentId = uuid7() as Id<'UploadedDocument'>;
    const now = Temporal.Instant.from('2019-01-01T00:00:00Z');
    const unit = <T>(work: () => Promise<T>) =>
      persistence.unitOfWork
        .run(m, async () => ok(await work()))
        .then((r) => {
          if (!r.ok) throw new Error('refused');
          return r.value;
        });
    await unit(() => sellerSide.add(m, { id: certificateId, sellerId, typeId, now }));
    await unit(() =>
      sellerSide.addDocument(m, {
        id: documentId,
        certificateId,
        expectedVersion: 1,
        sellerId,
        typeId,
        position: 1,
        mediaType: 'application/pdf',
        byteSize: 1000,
        pageCount: 1,
        objectKey: keyOf(sellerId, documentId),
        dataKeyEnvelope: ENVELOPE,
        cleanSha256: sha(documentId),
        indexHmac: crypto.getRandomValues(new Uint8Array(32)),
        now,
      }),
    );
    return { sellerId, documentKey: keyOf(sellerId, documentId) };
  }

  /** The Market's platform subject, created when no other spec has. */
  async function platformSubject(m = market): Promise<string> {
    await sql.query(
      `INSERT INTO certification.platform_subjects (market_id, tenant_id, subject_id, created_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (market_id) DO NOTHING`,
      [m.marketId, m.tenantId, uuid7()],
    );
    const row = await sql.query<{ subject_id: string }>(
      `SELECT subject_id FROM certification.platform_subjects WHERE market_id = $1`,
      [m.marketId],
    );
    return row.rows[0]?.subject_id ?? '';
  }

  const ask = (keys: readonly string[]) =>
    persistence.unitOfWork
      .run(market, async () => ok(await files.unreferencedObjectKeys(market, keys)), {
        readOnly: true,
      })
      .then((r) => {
        if (!r.ok) throw new Error('refused');
        return r.value;
      });

  it('returns an unreferenced key of a seller of this Market, and not a referenced one', async () => {
    const seller = await sellerWithDocument();
    const orphan = keyOf(seller.sellerId, uuid7());
    expect(await ask([seller.documentKey, orphan])).toEqual([orphan]);
  });

  it('never returns a key of a seller of another Market, or of an unknown subject', async () => {
    const foreign = await sellerWithDocument(other);
    const foreignOrphan = keyOf(foreign.sellerId, uuid7());
    const unknown = keyOf(uuid7(), uuid7());
    expect(await ask([foreignOrphan, unknown])).toEqual([]);
  });

  it("returns an unreferenced key of this Market's platform subject only", async () => {
    const mine = keyOf(await platformSubject(market), uuid7());
    const theirs = keyOf(await platformSubject(other), uuid7());
    expect(await ask([mine, theirs])).toEqual([mine]);
  });

  it('answers an empty list for no keys and ignores a malformed subject segment', async () => {
    expect(await ask([])).toEqual([]);
    expect(await ask(['certification/not-a-uuid/x'])).toEqual([]);
  });
});
