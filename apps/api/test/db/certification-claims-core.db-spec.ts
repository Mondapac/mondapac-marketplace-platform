import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { EXPECTED_PRIVILEGES } from './expected-privileges';
import { registerTypesRegistrySuite } from './certification-types-registry.db-suite';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Certification migration 1 on PostgreSQL (docs/design/data/certification.md 3.1, 3.2, 3.4 to
// 3.7, 6.1, 8), for both Market fixtures: the constraints, the same-parent keys (CE4), the
// pointers, the open-certificate uniqueness (T1), the insert-only triggers and the grants. Raw
// SQL on the application and owner connections.

const T0 = '2026-10-08T00:00:00Z';
const HASH = `hmac-sha256:${'a'.repeat(64)}`;
const CIPHERTEXT = `v1.${'A'.repeat(48)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

/**
 * The insert-only tables of the schema (CE3), read from the expected privileges: a table of the
 * schema that the application may only SELECT and INSERT, except the outbox and the inbox, which
 * are queues. A new table of this shape without the two triggers fails the catalog test below.
 */
function insertOnlyTables(): string[] {
  return Object.entries(EXPECTED_PRIVILEGES.tables)
    .filter(
      ([name, grant]) =>
        name.startsWith('certification.') &&
        grant.table.join() === 'INSERT,SELECT' &&
        grant.columnUpdate.length === 0 &&
        ![
          'certification.outbox',
          'certification.inbox',
          // Insert-only by grant but not on the trigger list of data design 6.1.
          'certification.platform_subjects',
        ].includes(name),
    )
    .map(([name]) => name.slice('certification.'.length))
    .sort();
}

it('has exactly the row and the statement trigger on every insert-only table of the schema, and only there (CE3)', async () => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{
      table: string;
      tgname: string;
      tgtype: number;
      tgenabled: string;
      fn: string;
    }>(
      `SELECT c.relname AS "table", t.tgname, t.tgtype::int AS tgtype, t.tgenabled::text AS tgenabled,
              pn.nspname || '.' || p.proname AS fn
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE n.nspname = 'certification' AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`,
    );
    // tgtype bits: 1 row, 2 before, 8 delete, 16 update, 32 truncate.
    const ROW_UPDATE_DELETE = 1 | 2 | 8 | 16;
    const STATEMENT_TRUNCATE = 2 | 32;
    // Guard triggers other than the pair (before-update and before-insert rules of the columns
    // that do change), listed one by one: [table, trigger, tgtype, function].
    const GUARDS = [
      [
        'claim_terms',
        'claim_terms_revision_open',
        7,
        'certification.revision_content_guard_insert',
      ],
      [
        'issuer_contact_channels',
        'issuer_contact_channels_retire_once',
        19,
        'certification.issuer_contact_channels_guard_update',
      ],
      [
        'relaxation_proposals',
        'relaxation_proposals_one_way',
        19,
        'certification.relaxation_proposals_guard_update',
      ],
      [
        'type_revision_texts',
        'type_revision_texts_revision_open',
        7,
        'certification.revision_content_guard_insert',
      ],
    ];
    const guardNames = new Set(GUARDS.map((g) => g[1]));
    expect(
      rows.filter((r) => guardNames.has(r.tgname)).map((r) => [r.table, r.tgname, r.tgtype, r.fn]),
    ).toEqual(GUARDS);
    expect(rows.filter((r) => guardNames.has(r.tgname)).every((r) => r.tgenabled === 'O')).toBe(
      true,
    );
    const pairs = rows.filter((r) => !guardNames.has(r.tgname));
    const byTable = new Map<string, typeof rows>();
    for (const row of pairs) byTable.set(row.table, [...(byTable.get(row.table) ?? []), row]);
    // Every trigger of the schema is one of the pair, on a listed table.
    expect([...byTable.keys()].sort()).toEqual(insertOnlyTables());
    for (const table of insertOnlyTables()) {
      expect(
        (byTable.get(table) ?? []).map((r) => [r.tgname, r.tgtype, r.tgenabled, r.fn]),
      ).toEqual([
        [`${table}_no_truncate`, STATEMENT_TRUNCATE, 'O', 'certification.reject_mutation'],
        [`${table}_no_update_delete`, ROW_UPDATE_DELETE, 'O', 'certification.reject_mutation'],
      ]);
    }
  } finally {
    await client.end();
  }
});

describe.each(TEST_MARKETS)('certification claims core in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
  });

  /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
  async function sqlState(
    client: Client,
    text: string,
    values: unknown[] = [],
  ): Promise<string | null> {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  const insertSql = (table: string, row: Record<string, unknown>): [string, unknown[]] => [
    `INSERT INTO certification.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(', ')})`,
    Object.values(row),
  ];
  async function insert(table: string, row: Record<string, unknown>): Promise<void> {
    await sql.query(...insertSql(table, row));
  }
  const insertState = (table: string, row: Record<string, unknown>) =>
    sqlState(sql, ...insertSql(table, row));

  const base = (marketId = market.marketId, tenantId = market.tenantId) => ({
    market_id: marketId,
    tenant_id: tenantId,
  });

  /** A type with its first revision published; mode and code are unique per call. */
  async function type(
    overrides: Record<string, unknown> = {},
    mode = 'THIRD_PARTY_DOCUMENT',
  ): Promise<{ typeId: string; revisionId: string }> {
    const typeId = uuid7();
    const revisionId = uuid7();
    await insert('certification_types', {
      id: typeId,
      ...base(),
      code: `t${typeId.slice(-12)}`,
      verification_mode: mode,
      status: 'active',
      published_revision_id: null,
      version: 1,
      created_at: T0,
      ...overrides,
    });
    await revision(typeId, mode, revisionId);
    await sql.query(
      `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
      [revisionId, typeId],
    );
    return { typeId, revisionId };
  }

  async function revision(
    typeId: string,
    mode = 'THIRD_PARTY_DOCUMENT',
    id = uuid7(),
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    await insert('certification_type_revisions', {
      id,
      ...base(),
      type_id: typeId,
      revision_no: 1,
      verification_mode: mode,
      requires_issuer_registry: true,
      requires_document: true,
      requires_expiry: true,
      default_basis: 'SELLER_REQUIRED',
      auto_approve_self_declaration: false,
      badge_icon_key: 'halal',
      author_account_id: uuid7(),
      created_at: T0,
      ...overrides,
    });
    return id;
  }

  async function issuer(typeId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuid7();
    await insert('issuers', {
      id,
      ...base(),
      type_id: typeId,
      display_name: 'Issuer One',
      display_name_key: `issuer ${id}`,
      accreditation_number: null,
      state: 'active',
      expert_reference_ciphertext: CIPHERTEXT,
      state_changed_at: T0,
      state_changed_by_kind: 'seed',
      state_changed_by_account_id: null,
      version: 1,
      created_at: T0,
      ...overrides,
    });
    return id;
  }

  async function certificate(
    typeId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = uuid7();
    await insert('seller_certifications', {
      id,
      ...base(),
      seller_id: uuid7(),
      type_id: typeId,
      status: 'draft',
      status_changed_at: T0,
      last_changed_at: T0,
      version: 1,
      created_at: T0,
      ...overrides,
    });
    return id;
  }

  async function submission(
    certificationId: string,
    typeId: string,
    typeRevisionId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = uuid7();
    const sellerId = (
      await sql.query<{ seller_id: string }>(
        `SELECT seller_id FROM certification.seller_certifications WHERE id = $1`,
        [certificationId],
      )
    ).rows[0]!.seller_id;
    await insert('seller_certification_submissions', {
      id,
      ...base(),
      seller_certification_id: certificationId,
      seller_id: sellerId,
      type_id: typeId,
      type_revision_id: typeRevisionId,
      submission_no: 1,
      kind: 'initial',
      content_schema_version: 1,
      content_hash: HASH,
      submitted_zone: 'Australia/Sydney',
      submitted_at: T0,
      submitted_by_account_id: uuid7(),
      ...overrides,
    });
    return id;
  }

  const decision = (submissionId: string, overrides: Record<string, unknown> = {}) => ({
    ...base(),
    submission_id: submissionId,
    outcome: 'approved',
    approved_zone: 'Australia/Sydney',
    actor_kind: 'admin',
    actor_account_id: uuid7(),
    decided_at: T0,
    ...overrides,
  });

  it('refuses a type or revision that breaks its checks', async () => {
    expect(
      await insertState('certification_types', {
        id: uuid7(),
        ...base(),
        code: 'Bad Code',
        verification_mode: 'SELF_DECLARATION',
        status: 'active',
        version: 1,
        created_at: T0,
      }),
    ).toBe('23514');
    const { typeId } = await type();
    const row = (overrides: Record<string, unknown>) => ({
      id: uuid7(),
      ...base(),
      type_id: typeId,
      revision_no: 7,
      verification_mode: 'THIRD_PARTY_DOCUMENT',
      requires_issuer_registry: true,
      requires_document: true,
      requires_expiry: true,
      default_basis: 'SELLER_REQUIRED',
      auto_approve_self_declaration: false,
      badge_icon_key: 'halal',
      author_account_id: uuid7(),
      created_at: T0,
      ...overrides,
    });
    // The default basis never allows the manufacturer basis (brief s5, AC 4).
    expect(
      await insertState(
        'certification_type_revisions',
        row({ default_basis: 'SELLER_OR_MANUFACTURER' }),
      ),
    ).toBe('23514');
    // Auto-approval belongs to a self declaration only (CERT-11).
    expect(
      await insertState(
        'certification_type_revisions',
        row({ auto_approve_self_declaration: true }),
      ),
    ).toBe('23514');
    expect(
      await insertState('certification_type_revisions', row({ badge_icon_key: 'Not An Icon' })),
    ).toBe('23514');
    expect(await insertState('certification_type_revisions', row({ revision_no: 0 }))).toBe(
      '23514',
    );
    expect(await insertState('certification_type_revisions', row({}))).toBeNull();
  });

  it('binds a revision to its type: the mode, the unique number, the published pointer', async () => {
    const a = await type();
    const b = await type({}, 'SELF_DECLARATION');
    // A revision cannot carry another mode than its type (H1).
    expect(
      await insertState('certification_type_revisions', {
        id: uuid7(),
        ...base(),
        type_id: a.typeId,
        revision_no: 2,
        verification_mode: 'SELF_DECLARATION',
        requires_issuer_registry: false,
        requires_document: false,
        requires_expiry: false,
        default_basis: 'SELLER_REQUIRED',
        auto_approve_self_declaration: false,
        badge_icon_key: 'halal',
        author_account_id: uuid7(),
        created_at: T0,
      }),
    ).toBe('23503');
    // Revision numbers are unique per type.
    expect(
      await sqlState(
        sql,
        `INSERT INTO certification.certification_type_revisions
           (id, market_id, tenant_id, type_id, revision_no, verification_mode,
            requires_issuer_registry, requires_document, requires_expiry, default_basis,
            auto_approve_self_declaration, badge_icon_key, author_account_id, created_at)
         SELECT $1, market_id, tenant_id, type_id, revision_no, verification_mode,
                requires_issuer_registry, requires_document, requires_expiry, default_basis,
                auto_approve_self_declaration, badge_icon_key, author_account_id, created_at
           FROM certification.certification_type_revisions WHERE id = $2`,
        [uuid7(), a.revisionId],
      ),
    ).toBe('23505');
    // The published pointer names a revision of this type only.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
        [b.revisionId, a.typeId],
      ),
    ).toBe('23503');
  });

  it('keeps one code per Market and refuses another Market’s rows', async () => {
    const { typeId } = await type({ code: `dup-${typeId7()}` });
    const code2 = (
      await sql.query<{ code: string }>(
        `SELECT code FROM certification.certification_types WHERE id = $1`,
        [typeId],
      )
    ).rows[0]!.code;
    expect(
      await insertState('certification_types', {
        id: uuid7(),
        ...base(),
        code: code2,
        verification_mode: 'THIRD_PARTY_DOCUMENT',
        status: 'active',
        version: 1,
        created_at: T0,
      }),
    ).toBe('23505');
    // The same code in the other Market is a different type.
    expect(
      await insertState('certification_types', {
        id: uuid7(),
        ...base(other.marketId, other.tenantId),
        code: code2,
        verification_mode: 'THIRD_PARTY_DOCUMENT',
        status: 'active',
        version: 1,
        created_at: T0,
      }),
    ).toBeNull();
    // A certificate cannot name a type of another Market (PM6).
    expect(
      await insertState('seller_certifications', {
        id: uuid7(),
        ...base(other.marketId, other.tenantId),
        seller_id: uuid7(),
        type_id: typeId,
        status: 'draft',
        status_changed_at: T0,
        last_changed_at: T0,
        version: 1,
        created_at: T0,
      }),
    ).toBe('23503');
  });

  it('allows one open certificate per seller and type, and a new one after a terminal state (T1)', async () => {
    const { typeId } = await type();
    const sellerId = uuid7();
    const first = await certificate(typeId, { seller_id: sellerId });
    expect(
      await insertState('seller_certifications', {
        id: uuid7(),
        ...base(),
        seller_id: sellerId,
        type_id: typeId,
        status: 'draft',
        status_changed_at: T0,
        last_changed_at: T0,
        version: 1,
        created_at: T0,
      }),
    ).toBe('23505');
    await sql.query(
      `UPDATE certification.seller_certifications SET status = 'declined' WHERE id = $1`,
      [first],
    );
    expect(await certificate(typeId, { seller_id: sellerId })).toBeTruthy();
    // Another seller, or another type, is a different slot.
    const otherType = await type();
    expect(await certificate(otherType.typeId, { seller_id: sellerId })).toBeTruthy();
    expect(await certificate(typeId)).toBeTruthy();
  });

  it('keeps the pointers of a certificate inside the certificate and distinct (CE4)', async () => {
    const { typeId, revisionId } = await type();
    const mine = await certificate(typeId);
    const theirs = await certificate(typeId);
    const mineSub = await submission(mine, typeId, revisionId);
    const theirSub = await submission(theirs, typeId, revisionId);
    // A pointer to another certificate's submission is refused.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications SET approved_submission_id = $1 WHERE id = $2`,
        [theirSub, mine],
      ),
    ).toBe('23503');
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications SET pending_submission_id = $1 WHERE id = $2`,
        [theirSub, mine],
      ),
    ).toBe('23503');
    // The approved and the pending pointer are never the same submission.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications
            SET approved_submission_id = $1, pending_submission_id = $1 WHERE id = $2`,
        [mineSub, mine],
      ),
    ).toBe('23514');
    // A boundary copy needs an approved pointer.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications SET approved_boundary_at = $1 WHERE id = $2`,
        [T0, mine],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications
            SET approved_submission_id = $1, approved_boundary_at = $3 WHERE id = $2`,
        [mineSub, mine, T0],
      ),
    ).toBeNull();
  });

  it('binds a submission to the type of its certificate, the revision and the issuer (CE4)', async () => {
    const a = await type();
    const b = await type();
    const cert = await certificate(a.typeId);
    const issuerA = await issuer(a.typeId);
    const issuerB = await issuer(b.typeId);
    const certSeller = (
      await sql.query<{ seller_id: string }>(
        `SELECT seller_id FROM certification.seller_certifications WHERE id = $1`,
        [cert],
      )
    ).rows[0]!.seller_id;
    const row = (overrides: Record<string, unknown>) => ({
      id: uuid7(),
      ...base(),
      seller_certification_id: cert,
      seller_id: certSeller,
      type_id: a.typeId,
      type_revision_id: a.revisionId,
      submission_no: 1,
      kind: 'initial',
      content_schema_version: 1,
      content_hash: HASH,
      submitted_zone: 'Australia/Sydney',
      submitted_at: T0,
      submitted_by_account_id: uuid7(),
      ...overrides,
    });
    // The revision of another type, the issuer of another type, and the certificate's type.
    expect(
      await insertState(
        'seller_certification_submissions',
        row({ type_revision_id: b.revisionId }),
      ),
    ).toBe('23503');
    expect(await insertState('seller_certification_submissions', row({ issuer_id: issuerB }))).toBe(
      '23503',
    );
    expect(
      await insertState(
        'seller_certification_submissions',
        row({ type_id: b.typeId, type_revision_id: b.revisionId }),
      ),
    ).toBe('23503');
    expect(
      await insertState('seller_certification_submissions', row({ issuer_id: issuerA })),
    ).toBeNull();
    // The submission number is unique per certificate.
    expect(await insertState('seller_certification_submissions', row({}))).toBe('23505');
    expect(
      await insertState('seller_certification_submissions', row({ submission_no: 2 })),
    ).toBeNull();
  });

  it('ties the seller of a submission to its certificate and fixes the certificate’s seller (M-1)', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    // A submission of another seller than its certificate's is refused.
    expect(
      await insertState('seller_certification_submissions', {
        id: uuid7(),
        ...base(),
        seller_certification_id: cert,
        seller_id: uuid7(),
        type_id: typeId,
        type_revision_id: revisionId,
        submission_no: 1,
        kind: 'initial',
        content_schema_version: 1,
        content_hash: HASH,
        submitted_zone: 'Australia/Sydney',
        submitted_at: T0,
        submitted_by_account_id: uuid7(),
      }),
    ).toBe('23503');
    // Once a submission exists, the certificate cannot move to another seller.
    await submission(cert, typeId, revisionId);
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications SET seller_id = $1 WHERE id = $2`,
        [uuid7(), cert],
      ),
    ).toBe('23503');
  });

  it('refuses a submission and an issuer that name rows of another Market', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    const certSeller = (
      await sql.query<{ seller_id: string }>(
        `SELECT seller_id FROM certification.seller_certifications WHERE id = $1`,
        [cert],
      )
    ).rows[0]!.seller_id;
    expect(
      await insertState('seller_certification_submissions', {
        id: uuid7(),
        ...base(other.marketId, other.tenantId),
        seller_certification_id: cert,
        seller_id: certSeller,
        type_id: typeId,
        type_revision_id: revisionId,
        submission_no: 1,
        kind: 'initial',
        content_schema_version: 1,
        content_hash: HASH,
        submitted_zone: 'Australia/Sydney',
        submitted_at: T0,
        submitted_by_account_id: uuid7(),
      }),
    ).toBe('23503');
    expect(
      await issuer(typeId, base(other.marketId, other.tenantId)).then(
        () => null,
        (error: { code?: string }) => error.code,
      ),
    ).toBe('23503');
  });

  it('checks the submission content: hash shape, ciphertext shape, dates, kind, zone', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    const fail = async (overrides: Record<string, unknown>): Promise<string | null> => {
      try {
        await submission(cert, typeId, revisionId, {
          submission_no: sequence++ + 10,
          ...overrides,
        });
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    };
    expect(await fail({ content_hash: 'sha256:abc' })).toBe('23514');
    expect(await fail({ certificate_number_ciphertext: 'plain text' })).toBe('23514');
    expect(await fail({ certificate_number_ciphertext: CIPHERTEXT })).toBeNull();
    expect(await fail({ kind: 'other' })).toBe('23514');
    expect(await fail({ issue_date: '2027-01-02', expiry_date: '2027-01-01' })).toBe('23514');
    expect(await fail({ issue_date: '2026-01-02', expiry_date: '2027-01-01' })).toBeNull();
    expect(await fail({ submitted_zone: '+10:00' })).toBe('23514');
    expect(await fail({ content_schema_version: 0 })).toBe('23514');
  });

  it('bounds a ciphertext column by the envelope and its limit: 40 refused, 41 and 512 accepted, 513 refused', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    const withNumber = async (length: number): Promise<string | null> => {
      try {
        await submission(cert, typeId, revisionId, {
          submission_no: sequence++ + 10,
          certificate_number_ciphertext: `v1.${'A'.repeat(length - 3)}`,
        });
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    };
    expect(await withNumber(40)).toBe('23514');
    expect(await withNumber(41)).toBeNull();
    expect(await withNumber(512)).toBeNull();
    expect(await withNumber(513)).toBe('23514');
  });

  it('checks the remaining rules of the decision and issuer rows and the version floor', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    const sub = async (): Promise<string> =>
      submission(await certificate(typeId), typeId, revisionId);
    const decide = async (overrides: Record<string, unknown>): Promise<string | null> =>
      insertState('seller_submission_decisions', decision(await sub(), overrides));
    // A boundary only on an approval; a reason only on a negative outcome; a cause only on a withdrawal.
    expect(
      await decide({
        outcome: 'declined',
        approved_zone: null,
        reason_code: 'not-valid',
        expiry_boundary_at: '2027-01-01T00:00:00Z',
      }),
    ).toBe('23514');
    expect(await decide({ approved_zone: 'Mars Olympus' })).toBe('23514');
    expect(await decide({ reason_text_ciphertext: 'plain text' })).toBe('23514');
    expect(await decide({ actor_kind: 'robot' })).toBe('23514');
    expect(
      await decide({ outcome: 'declined', approved_zone: null, reason_code: 'Bad Code' }),
    ).toBe('23514');
    expect(
      await decide({
        outcome: 'changes-requested',
        approved_zone: null,
        reason_code: 'needs-document',
        reason_text_ciphertext: CIPHERTEXT,
      }),
    ).toBeNull();
    expect(
      await decide({ outcome: 'withdrawn', approved_zone: null, withdraw_cause: 'edited' }),
    ).toBeNull();
    // Issuer rows: states, key normalisation, control characters, expert reference shape.
    const issuerState = (overrides: Record<string, unknown>) =>
      issuer(typeId, overrides).then(
        () => null,
        (error: { code?: string }) => error.code ?? 'unknown',
      );
    expect(await issuerState({ state: 'retired' })).toBe('23514');
    expect(await issuerState({ display_name_key: 'ﬁne' })).toBe('23514'); // not NFKC
    expect(await issuerState({ display_name: 'Bad\u202ename' })).toBe('23514');
    expect(await issuerState({ expert_reference_ciphertext: 'plain text' })).toBe('23514');
    // The version of every root starts at 1.
    expect(
      await sqlState(
        sql,
        `UPDATE certification.seller_certifications SET version = 0 WHERE id = $1`,
        [cert],
      ),
    ).toBe('23514');
  });

  /** The violated constraint of a statement that must fail, or null when it succeeded. */
  async function constraintOf(table: string, row: Record<string, unknown>): Promise<string | null> {
    try {
      await sql.query(...insertSql(table, row));
      return null;
    } catch (error) {
      return (error as { constraint?: string }).constraint ?? 'unknown';
    }
  }

  it('names the constraint that refuses each malformed row of every table (one case per CHECK)', async () => {
    const t = await type();
    const cert = await certificate(t.typeId);
    const certSeller = (
      await sql.query<{ seller_id: string }>(
        `SELECT seller_id FROM certification.seller_certifications WHERE id = $1`,
        [cert],
      )
    ).rows[0]!.seller_id;
    const sub = await submission(cert, t.typeId, t.revisionId);
    const envelope = (n: number): string => `v1.${'A'.repeat(n - 3)}`;
    const valid = {
      outbox: () => ({
        event_id: uuid7(),
        type: 'certification.type-created.v1',
        occurred_at: T0,
        ...base(),
        aggregate_type: 'certification-type',
        aggregate_id: uuid7(),
        aggregate_version: 1,
        correlation_id: 'corr-00000001',
        payload: '{}',
      }),
      inbox: () => ({
        event_id: uuid7(),
        handler: 'certification.some-handler',
        ...base(),
        processed_at: T0,
      }),
      certification_types: () => ({
        id: uuid7(),
        ...base(),
        code: `c${uuid7().slice(-10)}`,
        verification_mode: 'SELF_DECLARATION',
        status: 'active',
        version: 1,
        created_at: T0,
      }),
      issuers: () => ({
        id: uuid7(),
        ...base(),
        type_id: t.typeId,
        display_name: 'An Issuer',
        display_name_key: `an issuer ${uuid7()}`,
        state: 'active',
        expert_reference_ciphertext: CIPHERTEXT,
        state_changed_at: T0,
        state_changed_by_kind: 'seed',
        version: 1,
        created_at: T0,
      }),
      seller_certifications: () => ({
        id: uuid7(),
        ...base(),
        seller_id: uuid7(),
        type_id: t.typeId,
        status: 'draft',
        status_changed_at: T0,
        last_changed_at: T0,
        version: 1,
        created_at: T0,
      }),
      seller_certification_submissions: () => ({
        id: uuid7(),
        ...base(),
        seller_certification_id: cert,
        seller_id: certSeller,
        type_id: t.typeId,
        type_revision_id: t.revisionId,
        submission_no: sequence++ + 100,
        kind: 'initial',
        content_schema_version: 1,
        content_hash: HASH,
        submitted_zone: 'Australia/Sydney',
        submitted_at: T0,
        submitted_by_account_id: uuid7(),
      }),
      seller_submission_decisions: () => ({
        ...decision(uuid7()),
      }),
    } as const;
    const decisionRow = async (overrides: Record<string, unknown>) => ({
      ...decision(await submission(await certificate(t.typeId), t.typeId, t.revisionId), {}),
      ...overrides,
    });
    const cases: [string, Record<string, unknown>, string][] = [
      ['outbox', { type: 'sellers.x.v1' }, 'outbox_type_check'],
      ['outbox', { aggregate_type: 'Bad Type' }, 'outbox_aggregate_type_check'],
      ['outbox', { aggregate_version: 0 }, 'outbox_aggregate_version_check'],
      ['outbox', { correlation_id: 'short' }, 'outbox_correlation_id_check'],
      ['outbox', { payload: '[]' }, 'outbox_payload_check'],
      ['outbox', { market_id: 'au' }, 'outbox_market_id_check'],
      ['outbox', { tenant_id: 'Bad Tenant' }, 'outbox_tenant_id_check'],
      ['inbox', { handler: 'sellers.x' }, 'inbox_handler_check'],
      ['inbox', { market_id: 'au' }, 'inbox_market_id_check'],
      ['inbox', { tenant_id: 'Bad Tenant' }, 'inbox_tenant_id_check'],
      ['certification_types', { status: 'gone' }, 'certification_types_status_check'],
      [
        'certification_types',
        { verification_mode: 'OTHER' },
        'certification_types_verification_mode_check',
      ],
      ['certification_types', { version: 0 }, 'certification_types_version_check'],
      ['certification_types', { market_id: 'au' }, 'certification_types_market_id_check'],
      ['certification_types', { tenant_id: 'Bad Tenant' }, 'certification_types_tenant_id_check'],
      ['issuers', { version: 0 }, 'issuers_version_check'],
      ['issuers', { display_name: '' }, 'issuers_display_name_check'],
      ['issuers', { display_name: 'x'.repeat(201) }, 'issuers_display_name_check'],
      ['issuers', { display_name_key: ' padded ' }, 'issuers_display_name_key_check'],
      ['issuers', { display_name_key: 'k'.repeat(401) }, 'issuers_display_name_key_check'],
      ['issuers', { accreditation_number: '' }, 'issuers_accreditation_number_check'],
      ['issuers', { accreditation_number: 'A'.repeat(65) }, 'issuers_accreditation_number_check'],
      ['issuers', { accreditation_number: ' A1 ' }, 'issuers_accreditation_number_check'],
      ['issuers', { accreditation_number: 'A\u0007' }, 'issuers_accreditation_number_check'],
      ['issuers', { state_changed_by_kind: 'robot' }, 'issuers_state_changed_by_kind_check'],
      [
        'issuers',
        { expert_reference_ciphertext: envelope(4097) },
        'issuers_expert_reference_ciphertext_check',
      ],
      [
        'issuers',
        { expert_reference_ciphertext: envelope(40) },
        'issuers_expert_reference_ciphertext_check',
      ],
      ['issuers', { market_id: 'au' }, 'issuers_market_id_check'],
      ['seller_certifications', { status: 'gone' }, 'seller_certifications_status_check'],
      ['seller_certifications', { market_id: 'au' }, 'seller_certifications_market_id_check'],
      [
        'seller_certifications',
        { tenant_id: 'Bad Tenant' },
        'seller_certifications_tenant_id_check',
      ],
      [
        'seller_certification_submissions',
        { submission_no: 0 },
        'seller_certification_submissions_submission_no_check',
      ],
      [
        'seller_certification_submissions',
        { submitted_zone: 'Z'.repeat(65) },
        'seller_certification_submissions_submitted_zone_check',
      ],
      [
        'seller_certification_submissions',
        { self_declaration_note_ciphertext: envelope(8193) },
        'seller_certification_submissions_note_ciphertext_check',
      ],
      [
        'seller_certification_submissions',
        { self_declaration_note_ciphertext: 'plain' },
        'seller_certification_submissions_note_ciphertext_check',
      ],
      [
        'seller_certification_submissions',
        { market_id: 'au' },
        'seller_certification_submissions_market_id_check',
      ],
      [
        'seller_certification_submissions',
        { tenant_id: 'Bad Tenant' },
        'seller_certification_submissions_tenant_id_check',
      ],
    ];
    for (const [table, overrides, constraint] of cases) {
      const row = { ...valid[table as keyof typeof valid](), ...overrides };
      expect({ table, overrides, constraint: await constraintOf(table, row) }).toEqual({
        table,
        overrides,
        constraint,
      });
    }
    // The positive control of every table: the unmodified row is accepted.
    for (const table of Object.keys(valid).filter((k) => k !== 'seller_submission_decisions')) {
      expect(await constraintOf(table, valid[table as keyof typeof valid]())).toBeNull();
    }
    // The bounds that are accepted exactly at the limit.
    expect(
      await constraintOf('issuers', {
        ...valid.issuers(),
        expert_reference_ciphertext: envelope(4096),
      }),
    ).toBeNull();
    expect(
      await constraintOf('seller_certification_submissions', {
        ...valid.seller_certification_submissions(),
        self_declaration_note_ciphertext: envelope(8192),
      }),
    ).toBeNull();
    // The decisions: each half of the pairing checks, and the shape checks.
    const dcases: [Record<string, unknown>, string][] = [
      [{ outcome: 'gone', approved_zone: null }, 'seller_submission_decisions_outcome_check'],
      [{ approved_zone: 'Z'.repeat(65) }, 'seller_submission_decisions_approved_zone_shape_check'],
      [
        { outcome: 'declined', reason_code: 'not-valid' },
        'seller_submission_decisions_approved_zone_check',
      ],
      [{ reason_code: 'not-valid' }, 'seller_submission_decisions_reason_code_check'],
      [
        {
          outcome: 'declined',
          approved_zone: null,
          reason_code: 'not-valid',
          withdraw_cause: 'edited',
        },
        'seller_submission_decisions_withdraw_pair_check',
      ],
      [{ withdraw_cause: 'edited' }, 'seller_submission_decisions_withdraw_pair_check'],
      [
        { outcome: 'withdrawn', approved_zone: null, withdraw_cause: 'gone' },
        'seller_submission_decisions_withdraw_cause_check',
      ],
      [
        { reason_text_ciphertext: envelope(8193) },
        'seller_submission_decisions_reason_text_ciphertext_check',
      ],
      [{ actor_kind: 'system' }, 'seller_submission_decisions_actor_pair_check'],
      [{ actor_account_id: null }, 'seller_submission_decisions_actor_pair_check'],
      [{ market_id: 'au' }, 'seller_submission_decisions_market_id_check'],
      [{ tenant_id: 'Bad Tenant' }, 'seller_submission_decisions_tenant_id_check'],
    ];
    for (const [overrides, constraint] of dcases) {
      expect({
        overrides,
        constraint: await constraintOf('seller_submission_decisions', await decisionRow(overrides)),
      }).toEqual({
        overrides,
        constraint,
      });
    }
    expect(sub).toBeTruthy();
  });

  it('names the foreign key that refuses a row of another Market', async () => {
    const t = await type();
    const cert = await certificate(t.typeId);
    const sub = await submission(cert, t.typeId, t.revisionId);
    const foreign = base(other.marketId, other.tenantId);
    expect(
      await constraintOf('seller_submission_decisions', {
        ...decision(sub),
        ...foreign,
      }),
    ).toBe('seller_submission_decisions_market_id_submission_id_fkey');
    expect(
      await constraintOf('issuers', {
        id: uuid7(),
        ...foreign,
        type_id: t.typeId,
        display_name: 'Foreign',
        display_name_key: `foreign ${uuid7()}`,
        state: 'proposed',
        state_changed_at: T0,
        state_changed_by_kind: 'seed',
        version: 1,
        created_at: T0,
      }),
    ).toBe('issuers_market_id_type_id_fkey');
  });

  it('frees the open-certificate slot for declined and revoked only (T1)', async () => {
    const t = await type();
    const open = async (status: string): Promise<string | null> => {
      const sellerId = uuid7();
      await certificate(t.typeId, { seller_id: sellerId, status });
      return constraintOf('seller_certifications', {
        id: uuid7(),
        ...base(),
        seller_id: sellerId,
        type_id: t.typeId,
        status: 'draft',
        status_changed_at: T0,
        last_changed_at: T0,
        version: 1,
        created_at: T0,
      });
    };
    for (const status of ['draft', 'in-review', 'approved', 'changes-needed', 'expired']) {
      expect(await open(status)).toBe('seller_certifications_market_id_seller_id_type_id_open_key');
    }
    for (const status of ['declined', 'revoked']) expect(await open(status)).toBeNull();
  });

  it('keeps the issuer registry rules: no active issuer without an expert reference, unique names', async () => {
    const a = await type();
    const b = await type();
    expect(
      await insertState('issuers', {
        id: uuid7(),
        ...base(),
        type_id: a.typeId,
        display_name: 'No Reference',
        display_name_key: 'no reference',
        state: 'active',
        state_changed_at: T0,
        state_changed_by_kind: 'seed',
        version: 1,
        created_at: T0,
      }),
    ).toBe('23514');
    // A proposed issuer may have none.
    expect(
      await insertState('issuers', {
        id: uuid7(),
        ...base(),
        type_id: a.typeId,
        display_name: 'Proposed',
        display_name_key: 'proposed',
        state: 'proposed',
        state_changed_at: T0,
        state_changed_by_kind: 'seed',
        version: 1,
        created_at: T0,
      }),
    ).toBeNull();
    await issuer(a.typeId, { display_name: 'Same Name', display_name_key: 'same name' });
    expect(
      await issuer(a.typeId, { display_name: 'Same Name', display_name_key: 'same name' }).then(
        () => null,
        (error: { code?: string }) => error.code,
      ),
    ).toBe('23505');
    // The same name under another type is allowed.
    expect(
      await issuer(b.typeId, { display_name: 'Same Name', display_name_key: 'same name' }),
    ).toBeTruthy();
    // The accreditation reference is unique per type when present.
    await issuer(a.typeId, { accreditation_number: 'ACC-1' });
    expect(
      await issuer(a.typeId, { accreditation_number: 'ACC-1' }).then(
        () => null,
        (error: { code?: string }) => error.code,
      ),
    ).toBe('23505');
    // The state changer is the seed exactly when there is no account.
    expect(
      await issuer(a.typeId, { state_changed_by_kind: 'admin' }).then(
        () => null,
        (error: { code?: string }) => error.code,
      ),
    ).toBe('23514');
    expect(
      await issuer(a.typeId, { display_name: ' padded ' }).then(
        () => null,
        (error: { code?: string }) => error.code,
      ),
    ).toBe('23514');
  });

  it('holds one terminal outcome per submission with its pairing rules', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    const sub = await submission(cert, typeId, revisionId);
    expect(
      await insertState('seller_submission_decisions', decision(sub, { approved_zone: null })),
    ).toBe('23514');
    expect(
      await insertState(
        'seller_submission_decisions',
        decision(sub, {
          outcome: 'declined',
          approved_zone: null,
          reason_code: null,
        }),
      ),
    ).toBe('23514');
    expect(
      await insertState(
        'seller_submission_decisions',
        decision(sub, { outcome: 'withdrawn', approved_zone: null, withdraw_cause: null }),
      ),
    ).toBe('23514');
    expect(
      await insertState('seller_submission_decisions', decision(sub, { actor_kind: 'system' })),
    ).toBe('23514');
    expect(
      await insertState('seller_submission_decisions', {
        ...decision(sub),
        expiry_boundary_at: '2027-02-01T00:00:00Z',
      }),
    ).toBeNull();
    // One outcome per submission.
    expect(await insertState('seller_submission_decisions', decision(sub))).toBe('23505');
    // The decision names a submission of its own Market.
    const otherSub = await submission(await certificate(typeId), typeId, revisionId);
    expect(
      await insertState(
        'seller_submission_decisions',
        decision(otherSub, base(other.marketId, other.tenantId)),
      ),
    ).toBe('23503');
  });

  it('keeps revisions, submissions and decisions insert-only: 42501 for the application, 23001 for the owner', async () => {
    const { typeId, revisionId } = await type();
    const cert = await certificate(typeId);
    const sub = await submission(cert, typeId, revisionId);
    await insert('seller_submission_decisions', decision(sub));
    // A row in each table of migration 2 that the trigger guards.
    const draftRevision = await revision(typeId, 'THIRD_PARTY_DOCUMENT', uuid7(), {
      revision_no: 2,
    });
    await insert('type_revision_texts', {
      ...base(),
      type_revision_id: draftRevision,
      locale: 'en',
      name: 'Halal',
      customer_description: 'Certified halal.',
    });
    await insert('claim_terms', {
      ...base(),
      type_revision_id: draftRevision,
      locale: 'en',
      phrase: 'halal',
    });
    const tables = insertOnlyTables();
    expect(tables).toEqual(
      expect.arrayContaining([
        'certification_type_revisions',
        'seller_certification_submissions',
        'seller_submission_decisions',
      ]),
    );
    for (const table of tables) {
      expect(
        await sqlState(sql, `UPDATE certification.${table} SET market_id = market_id WHERE false`),
      ).toBe('42501');
      expect(await sqlState(sql, `DELETE FROM certification.${table} WHERE false`)).toBe('42501');
      expect(await sqlState(sql, `TRUNCATE certification.${table} CASCADE`)).toBe('42501');
      // On a real row, so that the row trigger fires (a WHERE false would never reach it).
      expect(
        await sqlState(
          owner,
          `UPDATE certification.${table} SET market_id = market_id WHERE market_id = $1`,
          [market.marketId],
        ),
      ).toBe('23001');
      expect(
        await sqlState(owner, `DELETE FROM certification.${table} WHERE market_id = $1`, [
          market.marketId,
        ]),
      ).toBe('23001');
      expect(await sqlState(owner, `TRUNCATE certification.${table} CASCADE`)).toBe('23001');
    }
    const kept = await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM certification.seller_certification_submissions WHERE id = $1`,
      [sub],
    );
    expect(kept.rows[0]?.n).toBe(1);
  });

  it('grants the application only the columns of the design to change (H1, CERT-03, CERT-04)', async () => {
    const { typeId } = await type();
    const issuerId = await issuer(typeId);
    for (const column of ['code', 'verification_mode', 'created_at']) {
      expect(
        await sqlState(
          sql,
          `UPDATE certification.certification_types SET ${column} = ${column} WHERE id = $1`,
          [typeId],
        ),
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql,
        `UPDATE certification.certification_types SET status = 'inactive', version = 2 WHERE id = $1`,
        [typeId],
      ),
    ).toBeNull();
    expect(
      await sqlState(sql, `DELETE FROM certification.certification_types WHERE id = $1`, [typeId]),
    ).toBe('42501');
    for (const column of ['type_id', 'created_at']) {
      expect(
        await sqlState(
          sql,
          `UPDATE certification.issuers SET ${column} = ${column} WHERE id = $1`,
          [issuerId],
        ),
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql,
        `UPDATE certification.issuers SET state = 'closed-to-new', version = 2 WHERE id = $1`,
        [issuerId],
      ),
    ).toBeNull();
    expect(await sqlState(sql, `DELETE FROM certification.issuers WHERE id = $1`, [issuerId])).toBe(
      '42501',
    );
    // The outbox envelope never changes; only published_at.
    expect(
      await sqlState(sql, `UPDATE certification.outbox SET payload = payload WHERE false`),
    ).toBe('42501');
  });
});

function typeId7(): string {
  return uuid7().slice(-8);
}

// Migration 2 runs in this worker (see the suite's header).
registerTypesRegistrySuite();
