import { createHash } from 'node:crypto';
import { err, ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import type { NewIssuerRequest } from '../../src/modules/certification/application/ports/issuer-request.repository';
import { PrismaIssuerRequestRepository } from '../../src/modules/certification/infrastructure/prisma-issuer-request.repository';
import { PrismaSellerCertificateRepository } from '../../src/modules/certification/infrastructure/prisma-seller-certificate.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Certification migration 20261017130000 ("my issuer is not listed", slice 6) on PostgreSQL, for
// both Market fixtures: the repository over the real tables (add, queue, find, answer, notice, the
// seller's open-request code) and the constraints, triggers and grants of `issuer_requests` and
// `issuer_request_documents` (docs/design/data/certification.md 3.8, 6.1, 8).

const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');
const T1 = T0.add({ minutes: 5 });
const ENVELOPE = `v1.${'A'.repeat(48)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const sha = (text: string): Buffer => createHash('sha256').update(text).digest();

describe.each(TEST_MARKETS)('certification issuer requests in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let sql: Client;
  let owner: Client;
  let requests: PrismaIssuerRequestRepository;
  let certificates: PrismaSellerCertificateRepository;

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
    requests = new PrismaIssuerRequestRepository(persistence.service);
    certificates = new PrismaSellerCertificateRepository(persistence.service);
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
  async function insert(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row);
    await sql.query(
      `INSERT INTO certification.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  async function type(): Promise<string> {
    const typeId = uuid7();
    const revisionId = uuid7();
    await insert('certification_types', {
      id: typeId,
      ...base(),
      code: `t${typeId.slice(-12)}`,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T0.toString(),
    });
    await sql.query('BEGIN');
    await insert('certification_type_revisions', {
      id: revisionId,
      ...base(),
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
      ...base(),
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
    return typeId;
  }

  async function issuer(typeId: string): Promise<string> {
    const id = uuid7();
    await insert('issuers', {
      id,
      ...base(),
      type_id: typeId,
      display_name: 'Halal Authority',
      display_name_key: `issuer ${id}`,
      accreditation_number: null,
      state: 'active',
      expert_reference_ciphertext: ENVELOPE,
      state_changed_at: T0.toString(),
      state_changed_by_kind: 'seed',
      state_changed_by_account_id: null,
      version: 1,
      created_at: T0.toString(),
    });
    return id;
  }

  function newRequest(typeId: string, seller = uuid7(), now = T0): NewIssuerRequest {
    const documentId = uuid7() as Id<'UploadedDocument'>;
    return {
      id: uuid7() as Id<'IssuerRequest'>,
      sellerId: seller as Id<'Seller'>,
      typeId: typeId as Id<'CertificationType'>,
      typedNameCiphertext: ENVELOPE,
      document: {
        id: documentId,
        mediaType: 'application/pdf',
        byteSize: 1000,
        pageCount: 1,
        objectKey: `certification/${seller}/${documentId}`,
        dataKeyEnvelope: ENVELOPE,
        cleanSha256: sha(documentId),
      },
      now,
    };
  }

  describe('the repository over the real tables', () => {
    it('adds a request with its file, lists it oldest first and reads it back', async () => {
      const typeId = await type();
      const first = newRequest(typeId, uuid7(), T0);
      const second = newRequest(typeId, uuid7(), T1);
      await inUnit(() => requests.add(market, second));
      await inUnit(() => requests.add(market, first));

      const queue = (await inUnit(() => requests.openQueue(market, 1000))).filter(
        (r) => r.id === first.id || r.id === second.id,
      );
      expect(queue.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(queue[0]).toMatchObject({ sellerId: first.sellerId, version: 1, documentCount: 1 });
      expect(queue[0]).not.toHaveProperty('typedNameCiphertext');

      const found = await inUnit(() => requests.find(market, first.id));
      expect(found).toMatchObject({
        id: first.id,
        sellerId: first.sellerId,
        typeId,
        typedNameCiphertext: ENVELOPE,
        state: 'open',
        issuerId: null,
        answerReasonCode: null,
        answeredAt: null,
        version: 1,
      });
      expect(found?.documents).toHaveLength(1);
      expect(found?.documents[0]).toMatchObject({
        id: first.document.id,
        position: 1,
        mediaType: 'application/pdf',
        purpose: 'issuer-request',
      });
      // Another Market sees nothing.
      expect(await inUnit(() => requests.find(other, first.id), other)).toBeNull();
      expect(
        (await inUnit(() => requests.openQueue(other, 1000), other)).some((r) => r.id === first.id),
      ).toBe(false);
      expect(await inUnit(() => requests.notice(other, first.id), other)).toBeNull();
    });

    it('answers once under the version: issuer-added, then frozen', async () => {
      const typeId = await type();
      const issuerId = await issuer(typeId);
      const request = newRequest(typeId);
      await inUnit(() => requests.add(market, request));
      const write = (expectedVersion: number) => ({
        id: request.id,
        expectedVersion,
        outcome: 'issuer-added' as const,
        issuerId: issuerId as Id<'Issuer'>,
        reasonCode: null,
        accountId: uuid7() as Id<'Account'>,
        answeredAt: T1,
      });
      await expect(inUnit(() => requests.answer(market, write(2)))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
      await expect(inUnit(() => requests.answer(other, write(1)), other)).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
      await inUnit(() => requests.answer(market, write(1)));
      expect(await inUnit(() => requests.find(market, request.id))).toMatchObject({
        state: 'issuer-added',
        issuerId,
        version: 2,
      });
      expect(await inUnit(() => requests.notice(market, request.id))).toMatchObject({
        sellerId: request.sellerId,
        state: 'issuer-added',
        answerReasonCode: null,
      });
      await expect(inUnit(() => requests.answer(market, write(2)))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
      expect(
        (await inUnit(() => requests.openQueue(market, 1000))).some((r) => r.id === request.id),
      ).toBe(false);
    });

    it('records not-accepted with its reason code', async () => {
      const typeId = await type();
      const request = newRequest(typeId);
      await inUnit(() => requests.add(market, request));
      await inUnit(() =>
        requests.answer(market, {
          id: request.id,
          expectedVersion: 1,
          outcome: 'not-accepted',
          issuerId: null,
          reasonCode: 'issuer-not-recognised',
          accountId: uuid7() as Id<'Account'>,
          answeredAt: T1,
        }),
      );
      expect(await inUnit(() => requests.notice(market, request.id))).toEqual({
        sellerId: request.sellerId,
        typeCode: expect.any(String) as string,
        state: 'not-accepted',
        answerReasonCode: 'issuer-not-recognised',
      });
    });

    it("shows the seller's draft of the type as draft-issuer-not-listed while a request is open", async () => {
      const typeId = await type();
      const seller = uuid7() as Id<'Seller'>;
      const certificateId = uuid7() as Id<'SellerCertification'>;
      await inUnit(() =>
        certificates.add(market, {
          id: certificateId,
          sellerId: seller,
          typeId: typeId as Id<'CertificationType'>,
          now: T0,
        }),
      );
      const before = await inUnit(() => certificates.findOwn(market, seller, certificateId));
      expect(before?.issuerRequestOpen).toBe(false);
      const request = newRequest(typeId, seller);
      await inUnit(() => requests.add(market, request));
      const during = await inUnit(() => certificates.findOwn(market, seller, certificateId));
      expect(during?.issuerRequestOpen).toBe(true);
      await inUnit(() =>
        requests.answer(market, {
          id: request.id,
          expectedVersion: 1,
          outcome: 'not-accepted',
          issuerId: null,
          reasonCode: 'issuer-not-recognised',
          accountId: uuid7() as Id<'Account'>,
          answeredAt: T1,
        }),
      );
      const after = await inUnit(() => certificates.findOwn(market, seller, certificateId));
      expect(after?.issuerRequestOpen).toBe(false);
    });
  });

  describe('constraints, triggers and grants', () => {
    async function stored() {
      const typeId = await type();
      const request = newRequest(typeId);
      await inUnit(() => requests.add(market, request));
      return { typeId, request };
    }

    it('freezes an answered request and moves an open one only to a final state, version + 1', async () => {
      const { typeId, request } = await stored();
      const issuerId = await issuer(typeId);
      // Back to open, or without the version step: refused by the guard.
      expect(
        await sqlState(sql, `UPDATE certification.issuer_requests SET version = 2 WHERE id = $1`, [
          request.id,
        ]),
      ).toBe('23001');
      expect(
        await sqlState(
          sql,
          `UPDATE certification.issuer_requests
             SET state = 'issuer-added', issuer_id = $2, answered_at = $3, answered_by_account_id = $4, version = 3
           WHERE id = $1`,
          [request.id, issuerId, T1.toString(), uuid7()],
        ),
      ).toBe('23001');
      // The pair checks: issuer-added without an issuer.
      expect(
        await constraintOf(
          `UPDATE certification.issuer_requests
             SET state = 'issuer-added', answered_at = $2, answered_by_account_id = $3, version = 2
           WHERE id = $1`,
          [request.id, T1.toString(), uuid7()],
        ),
      ).toBe('issuer_requests_issuer_pair_check');
      expect(
        await constraintOf(
          `UPDATE certification.issuer_requests
             SET state = 'not-accepted', answer_reason_code = 'x', version = 2
           WHERE id = $1`,
          [request.id],
        ),
      ).toBe('issuer_requests_answered_pair_check');
      expect(
        await sqlState(
          sql,
          `UPDATE certification.issuer_requests
             SET state = 'not-accepted', answer_reason_code = 'x', answered_at = $2,
                 answered_by_account_id = $3, version = 2
           WHERE id = $1`,
          [request.id, T1.toString(), uuid7()],
        ),
      ).toBeNull();
      expect(
        await sqlState(
          sql,
          `UPDATE certification.issuer_requests SET answer_reason_code = 'y', version = 3 WHERE id = $1`,
          [request.id],
        ),
      ).toBe('23001');
    });

    it('binds an issuer-added answer to an issuer of the same type', async () => {
      const { request } = await stored();
      const otherType = await type();
      const foreignIssuer = await issuer(otherType);
      expect(
        await constraintOf(
          `UPDATE certification.issuer_requests
             SET state = 'issuer-added', issuer_id = $2, answered_at = $3, answered_by_account_id = $4, version = 2
           WHERE id = $1`,
          [request.id, foreignIssuer, T1.toString(), uuid7()],
        ),
      ).toBe('issuer_requests_market_id_issuer_id_type_id_fkey');
    });

    it('checks the row shape: Market, tenant, ciphertext, state, reason code', async () => {
      const typeId = await type();
      const row = (extra: Record<string, unknown>) => ({
        id: uuid7(),
        ...base(),
        seller_id: uuid7(),
        type_id: typeId,
        typed_name_ciphertext: ENVELOPE,
        state: 'open',
        version: 1,
        created_at: T0.toString(),
        ...extra,
      });
      const tryInsert = (values: Record<string, unknown>) => {
        const columns = Object.keys(values);
        return constraintOf(
          `INSERT INTO certification.issuer_requests (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(values),
        );
      };
      expect(await tryInsert(row({ typed_name_ciphertext: 'Halal Authority of Nowhere' }))).toBe(
        'issuer_requests_typed_name_ciphertext_check',
      );
      // An unknown state is reached only through the answer path (an INSERT is guarded to open).
      const open = row({});
      expect(await tryInsert(open)).toBeNull();
      expect(
        await constraintOf(
          `UPDATE certification.issuer_requests
             SET state = 'pending', answered_at = $2, answered_by_account_id = $3, version = 2
           WHERE id = $1`,
          [open.id, T1.toString(), uuid7()],
        ),
      ).toBe('issuer_requests_state_check');
      expect(await tryInsert(row({ market_id: 'au' }))).toBe('issuer_requests_market_id_check');
      expect(await tryInsert(row({ tenant_id: 'Default' }))).toBe(
        'issuer_requests_tenant_id_check',
      );
      expect(await tryInsert(row({ answer_reason_code: 'Bad Code' }))).toBe(
        'issuer_requests_answer_reason_code_check',
      );
      expect(await tryInsert(row({ type_id: uuid7() }))).toBe(
        'issuer_requests_market_id_type_id_fkey',
      );
    });

    it('links only a clean issuer-request file of the same seller and type, append-only', async () => {
      const { typeId, request } = await stored();
      const link = {
        ...base(),
        issuer_request_id: request.id,
        type_id: typeId,
        seller_id: request.sellerId,
        document_id: request.document.id,
        position: 1,
      };
      // A second link of the same file, or under another seller: refused.
      expect(
        await constraintOf(
          `INSERT INTO certification.issuer_request_documents
             (market_id, tenant_id, issuer_request_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [...Object.values({ ...link, position: 2 })],
        ),
      ).toMatch(/pkey$|_key$/);
      expect(
        await constraintOf(
          `INSERT INTO certification.issuer_request_documents
             (market_id, tenant_id, issuer_request_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [...Object.values({ ...link, seller_id: uuid7(), document_id: uuid7(), position: 2 })],
        ),
      ).toBe('23514');
      // A clean file of another purpose (a certificate file) is not an issuer-request file.
      const certificateDocument = uuid7();
      await insert('uploaded_documents', {
        id: certificateDocument,
        ...base(),
        owner_seller_id: request.sellerId,
        type_id: typeId,
        purpose: 'seller-certificate',
        state: 'clean',
        media_type: 'application/pdf',
        byte_size: 1000,
        page_count: 1,
        object_key: `certification/${request.sellerId}/${certificateDocument}`,
        data_key_envelope: ENVELOPE,
        clean_sha256: sha(certificateDocument),
        version: 1,
        created_at: T0.toString(),
      });
      expect(
        await constraintOf(
          `INSERT INTO certification.issuer_request_documents
             (market_id, tenant_id, issuer_request_id, type_id, seller_id, document_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [...Object.values({ ...link, document_id: certificateDocument, position: 2 })],
        ),
      ).toBe('23514');
      // Append-only, even for the owner.
      expect(
        await sqlState(
          owner,
          `UPDATE certification.issuer_request_documents SET position = 3 WHERE issuer_request_id = $1`,
          [request.id],
        ),
      ).not.toBeNull();
      expect(
        await sqlState(
          owner,
          `DELETE FROM certification.issuer_request_documents WHERE issuer_request_id = $1`,
          [request.id],
        ),
      ).not.toBeNull();
    });

    it('inserts a request only open at version 1 (Hassan L1)', async () => {
      const typeId = await type();
      const issuerId = await issuer(typeId);
      const row = (extra: Record<string, unknown>) => ({
        id: uuid7(),
        ...base(),
        seller_id: uuid7(),
        type_id: typeId,
        typed_name_ciphertext: ENVELOPE,
        state: 'open',
        version: 1,
        created_at: T0.toString(),
        ...extra,
      });
      const tryInsert = (values: Record<string, unknown>, client = sql) => {
        const columns = Object.keys(values);
        return sqlState(
          client,
          `INSERT INTO certification.issuer_requests (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(values),
        );
      };
      const answered = {
        answered_at: T1.toString(),
        answered_by_account_id: uuid7(),
      };
      // Born answered, with every pair check satisfied: refused by the guard, for the owner too.
      expect(
        await tryInsert(
          row({ state: 'issuer-added', issuer_id: issuerId, ...answered, version: 2 }),
        ),
      ).toBe('23001');
      expect(
        await tryInsert(
          row({ state: 'not-accepted', answer_reason_code: 'issuer-not-recognised', ...answered }),
          owner,
        ),
      ).toBe('23001');
      expect(await tryInsert(row({ version: 2 }))).toBe('23001');
      expect(await tryInsert(row({ version: 0 }), owner)).toBe('23001');
      expect(await tryInsert(row({}))).toBeNull();
    });

    it('keeps one open request per seller and type (Hassan L2); answered, the type is free again', async () => {
      const typeId = await type();
      const seller = uuid7();
      const first = newRequest(typeId, seller);
      expect(await inUnit(() => requests.add(market, first))).toBeNull();
      expect(await inUnit(() => requests.hasOpen(market, first.sellerId, first.typeId))).toBe(true);
      expect(await inUnit(() => requests.hasOpen(other, first.sellerId, first.typeId), other)).toBe(
        false,
      );
      // The second: refused by the unique partial index, and its unit writes nothing.
      const second = newRequest(typeId, seller);
      const refused = await persistence.unitOfWork.run(market, async () => {
        const added = await requests.add(market, second);
        return added === null ? ok(null) : err({ code: added });
      });
      expect(refused).toEqual({ ok: false, error: { code: 'issuer-request.already-open' } });
      const left = await sql.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM certification.issuer_requests WHERE id = $1)::int
              + (SELECT count(*) FROM certification.uploaded_documents WHERE id = $2)::int AS n`,
        [second.id, second.document.id],
      );
      expect(left.rows[0]?.n).toBe(0);
      // Another seller, or the same seller of another type, may ask.
      expect(await inUnit(() => requests.add(market, newRequest(typeId)))).toBeNull();
      const otherType = await type();
      expect(await inUnit(() => requests.add(market, newRequest(otherType, seller)))).toBeNull();
      // Answered, a new open request of the same seller and type is allowed.
      await inUnit(() =>
        requests.answer(market, {
          id: first.id,
          expectedVersion: 1,
          outcome: 'not-accepted',
          issuerId: null,
          reasonCode: 'issuer-not-recognised',
          accountId: uuid7() as Id<'Account'>,
          answeredAt: T1,
        }),
      );
      expect(await inUnit(() => requests.add(market, newRequest(typeId, seller)))).toBeNull();
    });

    it('grants the API no DELETE and no UPDATE of the typed name, the seller or the type', async () => {
      const { request } = await stored();
      expect(
        await sqlState(sql, `DELETE FROM certification.issuer_requests WHERE id = $1`, [
          request.id,
        ]),
      ).toBe('42501');
      expect(
        await sqlState(
          sql,
          `UPDATE certification.issuer_requests SET typed_name_ciphertext = $2 WHERE id = $1`,
          [request.id, ENVELOPE],
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          sql,
          `UPDATE certification.issuer_requests SET seller_id = $2 WHERE id = $1`,
          [request.id, uuid7()],
        ),
      ).toBe('42501');
      expect(await sqlState(sql, `TRUNCATE certification.issuer_requests`)).toBe('42501');
    });
  });
});
