import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Certification migration 2 on PostgreSQL (docs/design/data/certification.md 3.2, 3.3, 3.7,
// 3.20, 3.22, 4.4, 6.1, 8), for both Market fixtures: revision texts and claim terms, issuer
// contact channels, relaxation proposals, platform subject keys, and the reason ciphertext of a
// revision. The insert-only triggers and the grants are also covered by the catalog tests of
// the claims-core spec, which read the expected privileges. This is a suite, not a spec file: the
// claims-core spec registers it, so that both run in one worker (the owner's TRUNCATE probes lock
// the whole schema and would deadlock with the inserts of a second worker).

const T0 = '2026-10-08T00:00:00Z';
const T1 = '2026-10-09T00:00:00Z';
const CIPHERTEXT = `v1.${'A'.repeat(48)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

export function registerTypesRegistrySuite(): void {
  describe.each(TEST_MARKETS)('certification types registry in market %s (database)', (code) => {
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

    /** True while a test body runs in its transaction on the application connection. */
    let inTx = false;
    /**
     * Runs a test body in one transaction on the application connection and rolls it back: the
     * guards of texts and claim terms accept them only in the transaction that saved the revision
     * (Hassan M2). A failing statement is wrapped in a savepoint so the body can go on.
     */
    const rolled =
      <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
      async (...args: A): Promise<void> => {
        await sql.query('BEGIN');
        inTx = true;
        try {
          await fn(...args);
        } finally {
          inTx = false;
          await sql.query('ROLLBACK');
        }
      };
    /** Commits what `fn` writes in one transaction (a revision saved with its content). */
    async function committed<T>(fn: () => Promise<T>): Promise<T> {
      await sql.query('BEGIN');
      inTx = true;
      try {
        const result = await fn();
        inTx = false;
        await sql.query('COMMIT');
        return result;
      } catch (error) {
        inTx = false;
        await sql.query('ROLLBACK');
        throw error;
      }
    }

    /** The failure of a statement that must fail ({ code, constraint }), or null when it succeeded. */
    async function failure(
      client: Client,
      text: string,
      values: unknown[] = [],
    ): Promise<{ code: string; constraint?: string } | null> {
      const guarded = inTx && client === sql;
      try {
        if (guarded) await client.query('SAVEPOINT f');
        await client.query(text, values);
        if (guarded) await client.query('RELEASE f');
        return null;
      } catch (error) {
        if (guarded) await client.query('ROLLBACK TO f; RELEASE f');
        const e = error as { code?: string; constraint?: string };
        return { code: e.code ?? 'unknown', ...(e.constraint ? { constraint: e.constraint } : {}) };
      }
    }

    const insertSql = (table: string, row: Record<string, unknown>): [string, unknown[]] => [
      `INSERT INTO certification.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(
        row,
      )
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`,
      Object.values(row),
    ];
    async function insert(table: string, row: Record<string, unknown>): Promise<void> {
      await sql.query(...insertSql(table, row));
    }
    const insertFailure = (table: string, row: Record<string, unknown>) =>
      failure(sql, ...insertSql(table, row));

    const base = (marketId = market.marketId, tenantId = market.tenantId) => ({
      market_id: marketId,
      tenant_id: tenantId,
    });

    async function type(): Promise<{ typeId: string; revisionId: string }> {
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
        created_at: T0,
      });
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
        created_at: T0,
      });
      return { typeId, revisionId };
    }

    const text = (revisionId: string, overrides: Record<string, unknown> = {}) => ({
      ...base(),
      type_revision_id: revisionId,
      locale: 'en-AU',
      name: 'Halal',
      customer_description: 'Certified halal by an accredited body.',
      ...overrides,
    });

    const BS = String.fromCharCode(92);
    // Built from code points: C0, C1, Arabic letter mark, LRM/RLM, bidi override and isolate.
    const CONTROLS = [0x07, 0x85, 0x61c, 0x200e, 0x200f, 0x202e, 0x2066].map(
      (c) => `a${String.fromCharCode(c)}b`,
    );

    describe('revision texts', () => {
      it.each([
        ['an empty name', { name: '' }, 'name_check'],
        ['an over-long name', { name: 'x'.repeat(101) }, 'name_check'],
        ['outer spaces in the name', { name: ' Halal' }, 'name_check'],
        ['an empty description', { customer_description: '' }, 'customer_description_check'],
        [
          'an over-long description',
          { customer_description: 'x'.repeat(2001) },
          'customer_description_check',
        ],
        [
          'outer spaces in the description',
          { customer_description: 'Halal ' },
          'customer_description_check',
        ],
        ['a bad locale (lower-case region)', { locale: 'en-au' }, 'locale_check'],
        ['a bad locale (underscore)', { locale: 'en_AU' }, 'locale_check'],
        ['a bad market id', { market_id: 'au' }, 'market_id_check'],
        ['a bad tenant id', { tenant_id: 'Default' }, 'tenant_id_check'],
        ...CONTROLS.flatMap((c): [string, Record<string, unknown>, string][] => [
          [
            `a control or bidi character in the name (U+${c.charCodeAt(1).toString(16)})`,
            { name: c },
            'name_check',
          ],
          [
            `a control or bidi character in the description (U+${c.charCodeAt(1).toString(16)})`,
            { customer_description: c },
            'customer_description_check',
          ],
        ]),
      ])(
        'names the violated check: %s',
        rolled(async (_label, overrides, name) => {
          const { revisionId } = await type();
          expect(await insertFailure('type_revision_texts', text(revisionId, overrides))).toEqual({
            code: '23514',
            constraint: `type_revision_texts_${name}`,
          });
        }),
      );

      it(
        'accepts the usual locales, one text per revision and locale',
        rolled(async () => {
          const { revisionId } = await type();
          for (const locale of ['en', 'en-AU', 'ar', 'zh-Hant-TW', 'es-419']) {
            expect(
              await insertFailure('type_revision_texts', text(revisionId, { locale })),
            ).toBeNull();
          }
          expect(await insertFailure('type_revision_texts', text(revisionId))).toEqual({
            code: '23505',
            constraint: 'type_revision_texts_pkey',
          });
        }),
      );

      it(
        'is bound to a revision of the same Market (CE4)',
        rolled(async () => {
          const { revisionId } = await type();
          const result = await insertFailure(
            'type_revision_texts',
            text(revisionId, { ...base(other.marketId, other.tenantId) }),
          );
          expect(result?.code).toBe('23503');
          expect(result?.constraint).toBe('type_revision_texts_market_id_type_revision_id_fkey');
        }),
      );

      it('refuses a text once the revision is published, proposed or saved in an earlier transaction: a change is a new revision (Hassan M2)', async () => {
        // Same transaction as the pointer: the pointer check refuses.
        await rolled(async () => {
          const published = await type();
          await insert('type_revision_texts', text(published.revisionId));
          await sql.query(
            `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
            [published.revisionId, published.typeId],
          );
          const result = await insertFailure(
            'type_revision_texts',
            text(published.revisionId, { locale: 'ar' }),
          );
          expect(result?.code).toBe('23001');
          const proposed = await type();
          await insert('relaxation_proposals', {
            id: uuid7(),
            ...base(),
            subject_kind: 'type-revision',
            subject_id: proposed.typeId,
            based_on_revision_id: null,
            proposed_revision_id: proposed.revisionId,
            proposed_expert_reference_ciphertext: null,
            state: 'pending',
            proposer_account_id: uuid7(),
            proposed_at: T0,
            decided_by_account_id: null,
            decided_at: null,
            change_reason_ciphertext: null,
            version: 1,
            created_at: T0,
          });
          expect(
            (await insertFailure('type_revision_texts', text(proposed.revisionId)))?.code,
          ).toBe('23001');
          // A revision of this very transaction, never pointed at, stays open.
          const open = await type();
          expect(await insertFailure('type_revision_texts', text(open.revisionId))).toBeNull();
        })();
        // A revision committed earlier, then pointed at and replaced: still sealed (the
        // superseded-revision gap). The pointer moves away and back; the texts stay refused.
        const first = await committed(async () => {
          const saved = await type();
          await insert('type_revision_texts', text(saved.revisionId));
          return saved;
        });
        expect(
          (await insertFailure('type_revision_texts', text(first.revisionId, { locale: 'ar' })))
            ?.code,
        ).toBe('23001');
        await sql.query(
          `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
          [first.revisionId, first.typeId],
        );
        await sql.query(
          `UPDATE certification.certification_types SET published_revision_id = NULL WHERE id = $1`,
          [first.typeId],
        );
        expect(
          (await insertFailure('type_revision_texts', text(first.revisionId, { locale: 'ar' })))
            ?.code,
        ).toBe('23001');
      });

      it('refuses content for a revision inserted under a savepoint: its xmin is the subtransaction (fail closed)', async () => {
        await rolled(async () => {
          await sql.query('SAVEPOINT s');
          const { revisionId } = await type();
          await sql.query('RELEASE s');
          expect((await insertFailure('type_revision_texts', text(revisionId)))?.code).toBe(
            '23001',
          );
        })();
      });

      it('guards truncation by its own trigger, not only through the cascade', async () => {
        // With the terms table's trigger off (inside a rolled-back transaction), the cascade reaches
        // it silently and only the texts trigger can refuse.
        await owner.query('BEGIN');
        try {
          await owner.query(
            'ALTER TABLE certification.claim_terms DISABLE TRIGGER claim_terms_no_truncate',
          );
          const refused = await failure(
            owner,
            'TRUNCATE certification.type_revision_texts CASCADE',
          );
          expect(refused?.code).toBe('23001');
        } finally {
          await owner.query('ROLLBACK');
        }
      });

      it('is insert-only for the application and the owner alike (CE3)', async () => {
        const { revisionId } = await committed(async () => {
          const saved = await type();
          await insert('type_revision_texts', text(saved.revisionId));
          return saved;
        });
        for (const client of [sql, owner]) {
          for (const statement of [
            `UPDATE certification.type_revision_texts SET name = 'X' WHERE type_revision_id = $1`,
            `DELETE FROM certification.type_revision_texts WHERE type_revision_id = $1`,
          ]) {
            const result = await failure(client, statement, [revisionId]);
            expect(result?.code).toBe(client === sql ? '42501' : '23001');
          }
        }
        expect(
          (await failure(owner, 'TRUNCATE certification.type_revision_texts CASCADE'))?.code,
        ).toBe('23001');
      });
    });

    describe('claim terms', () => {
      const term = (revisionId: string, overrides: Record<string, unknown> = {}) => ({
        ...base(),
        type_revision_id: revisionId,
        locale: 'en-AU',
        phrase: 'halal',
        ...overrides,
      });

      it.each([
        ['an empty phrase', { phrase: '' }],
        ['an over-long phrase', { phrase: 'x'.repeat(101) }],
        ['outer spaces', { phrase: 'halal ' }],
        ...CONTROLS.map((c): [string, Record<string, unknown>] => [
          `a control or bidi character (U+${c.charCodeAt(1).toString(16)})`,
          { phrase: c },
        ]),
        ['a bad market id', { market_id: 'au' }],
        ['a bad tenant id', { tenant_id: 'Default' }],
      ])(
        'names the violated check: %s',
        rolled(async (_label, overrides) => {
          const { revisionId } = await type();
          await insert('type_revision_texts', text(revisionId));
          const name =
            'market_id' in overrides
              ? 'market_id'
              : 'tenant_id' in overrides
                ? 'tenant_id'
                : 'phrase';
          const result = await insertFailure('claim_terms', term(revisionId, overrides));
          // A bad market or tenant id also breaks the foreign key; the check is evaluated first.
          expect(result).toEqual({ code: '23514', constraint: `claim_terms_${name}_check` });
        }),
      );

      it(
        'needs the text of its own locale, and holds each phrase once',
        rolled(async () => {
          const { revisionId } = await type();
          expect((await insertFailure('claim_terms', term(revisionId)))?.code).toBe('23503');
          await insert('type_revision_texts', text(revisionId));
          expect(await insertFailure('claim_terms', term(revisionId))).toBeNull();
          expect(await insertFailure('claim_terms', term(revisionId))).toEqual({
            code: '23505',
            constraint: 'claim_terms_pkey',
          });
          // The same phrase in another locale needs that locale's text.
          expect(
            (await insertFailure('claim_terms', term(revisionId, { locale: 'ar' })))?.code,
          ).toBe('23503');
        }),
      );

      it('refuses a term for a revision published or proposed in the same transaction (Hassan M2)', async () => {
        await rolled(async () => {
          const published = await type();
          await insert('type_revision_texts', text(published.revisionId));
          await sql.query(
            `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
            [published.revisionId, published.typeId],
          );
          expect((await insertFailure('claim_terms', term(published.revisionId)))?.code).toBe(
            '23001',
          );
          const proposed = await type();
          await insert('type_revision_texts', text(proposed.revisionId));
          expect(await insertFailure('claim_terms', term(proposed.revisionId))).toBeNull();
          await insert('relaxation_proposals', {
            id: uuid7(),
            ...base(),
            subject_kind: 'type-revision',
            subject_id: proposed.typeId,
            based_on_revision_id: null,
            proposed_revision_id: proposed.revisionId,
            proposed_expert_reference_ciphertext: null,
            state: 'pending',
            proposer_account_id: uuid7(),
            proposed_at: T0,
            decided_by_account_id: null,
            decided_at: null,
            change_reason_ciphertext: null,
            version: 1,
            created_at: T0,
          });
          expect(
            (await insertFailure('claim_terms', term(proposed.revisionId, { phrase: 'tayyib' })))
              ?.code,
          ).toBe('23001');
        })();
      });

      it('refuses a term in any later transaction than the one that saved the revision (Hassan M2)', async () => {
        const { revisionId } = await committed(async () => {
          const saved = await type();
          await insert('type_revision_texts', text(saved.revisionId));
          expect(await insertFailure('claim_terms', term(saved.revisionId))).toBeNull();
          return saved;
        });
        expect(
          (await insertFailure('claim_terms', term(revisionId, { phrase: 'tayyib' })))?.code,
        ).toBe('23001');
      });

      it('is insert-only for the application and the owner alike (CE3)', async () => {
        const { revisionId } = await committed(async () => {
          const saved = await type();
          await insert('type_revision_texts', text(saved.revisionId));
          await insert('claim_terms', term(saved.revisionId));
          return saved;
        });
        for (const client of [sql, owner]) {
          const state = client === sql ? '42501' : '23001';
          expect(
            (
              await failure(
                client,
                `UPDATE certification.claim_terms SET phrase = 'x' WHERE type_revision_id = $1`,
                [revisionId],
              )
            )?.code,
          ).toBe(state);
          expect(
            (
              await failure(
                client,
                `DELETE FROM certification.claim_terms WHERE type_revision_id = $1`,
                [revisionId],
              )
            )?.code,
          ).toBe(state);
        }
        expect((await failure(owner, 'TRUNCATE certification.claim_terms'))?.code).toBe('23001');
      });
    });

    describe('issuer contact channels', () => {
      async function issuer(typeId: string): Promise<string> {
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
        });
        return id;
      }
      const channel = (issuerId: string, overrides: Record<string, unknown> = {}) => ({
        id: uuid7(),
        ...base(),
        issuer_id: issuerId,
        kind: 'email-domain',
        value: 'issuer.example',
        retired_at: null,
        created_at: T0,
        ...overrides,
      });

      it.each([
        ['an unknown kind', { kind: 'fax' }, 'kind_check'],
        ['an empty value', { value: '' }, 'value_check'],
        ['an over-long value', { value: 'x'.repeat(256) }, 'value_check'],
        ['outer spaces', { value: ' issuer.example' }, 'value_check'],
        ['a control character', { value: 'issuer\u0007.example' }, 'value_check'],
        [
          'a bidi override',
          { value: `issuer${String.fromCharCode(0x202e)}.example` },
          'value_check',
        ],
        [
          'a retirement before the creation',
          { retired_at: '2026-10-07T00:00:00Z' },
          'retired_at_check',
        ],
        ['a bad market id', { market_id: 'au' }, 'market_id_check'],
        ['a bad tenant id', { tenant_id: 'Default' }, 'tenant_id_check'],
      ])('names the violated check: %s', async (_label, overrides, name) => {
        const { typeId } = await type();
        const issuerId = await issuer(typeId);
        expect(
          await insertFailure('issuer_contact_channels', channel(issuerId, overrides)),
        ).toEqual({ code: '23514', constraint: `issuer_contact_channels_${name}` });
      });

      it('is bound to an issuer of the same Market', async () => {
        const { typeId } = await type();
        const issuerId = await issuer(typeId);
        const result = await insertFailure(
          'issuer_contact_channels',
          channel(issuerId, { ...base(other.marketId, other.tenantId) }),
        );
        expect(result?.code).toBe('23503');
      });

      it('is only ever retired: the application changes no other column and never deletes', async () => {
        const { typeId } = await type();
        const issuerId = await issuer(typeId);
        const row = channel(issuerId);
        await insert('issuer_contact_channels', row);
        expect(
          await failure(
            sql,
            `UPDATE certification.issuer_contact_channels SET retired_at = $2 WHERE id = $1`,
            [row.id, T1],
          ),
        ).toBeNull();
        for (const column of ['value', 'kind', 'issuer_id', 'created_at']) {
          const result = await failure(
            sql,
            `UPDATE certification.issuer_contact_channels SET ${column} = ${column} WHERE id = $1`,
            [row.id],
          );
          expect(result?.code).toBe('42501');
        }
        expect(
          (
            await failure(sql, `DELETE FROM certification.issuer_contact_channels WHERE id = $1`, [
              row.id,
            ])
          )?.code,
        ).toBe('42501');
      });

      it('retires a channel once: never revived, never moved (Hassan L1)', async () => {
        const { typeId } = await type();
        const issuerId = await issuer(typeId);
        const row = channel(issuerId);
        await insert('issuer_contact_channels', row);
        const set = (value: string) =>
          failure(
            sql,
            `UPDATE certification.issuer_contact_channels SET retired_at = ${value} WHERE id = $1`,
            [row.id],
          );
        // Not yet retired: clearing it again is a no-op the guard refuses.
        expect((await set('NULL'))?.code).toBe('23001');
        expect(await set(`'${T1}'`)).toBeNull();
        expect((await set('NULL'))?.code).toBe('23001');
        expect((await set(`'${T0}'`))?.code).toBe('23001');
        expect((await set(`'${T1}'`))?.code).toBe('23001');
      });
    });

    describe('relaxation proposals', () => {
      const proposer = uuid7();
      const proposal = (overrides: Record<string, unknown> = {}) => ({
        id: uuid7(),
        ...base(),
        subject_kind: 'type-revision',
        subject_id: uuid7(),
        based_on_revision_id: null,
        proposed_revision_id: uuid7(),
        proposed_expert_reference_ciphertext: null,
        state: 'pending',
        proposer_account_id: proposer,
        proposed_at: T0,
        decided_by_account_id: null,
        decided_at: null,
        change_reason_ciphertext: null,
        version: 1,
        created_at: T0,
        ...overrides,
      });

      it.each([
        [
          'an unknown subject kind',
          { subject_kind: 'other', proposed_revision_id: null },
          'subject_kind_check',
        ],
        [
          'a type revision proposal without its proposed revision',
          { proposed_revision_id: null },
          'proposed_revision_check',
        ],
        [
          'a reactivation proposal that carries a proposed revision',
          { subject_kind: 'type-reactivation' },
          'proposed_revision_check',
        ],
        [
          'a reactivation of an issuer without the expert reference',
          { subject_kind: 'issuer-reactivation', proposed_revision_id: null },
          'expert_reference_check',
        ],
        [
          'an expert reference on another kind',
          { proposed_expert_reference_ciphertext: CIPHERTEXT },
          'expert_reference_check',
        ],
        ['an unknown state', { state: 'done', decided_at: T1 }, 'state_check'],
        ['a pending proposal with a decision time', { decided_at: T1 }, 'decided_at_check'],
        [
          'an approved proposal without a decider',
          { state: 'approved', decided_at: T1 },
          'decided_by_check',
        ],
        [
          'a decision by the proposer (second administrator)',
          { state: 'approved', decided_at: T1, decided_by_account_id: proposer },
          'second_admin_check',
        ],
        [
          'a reason below the shortest envelope',
          { change_reason_ciphertext: 'v1.short' },
          'change_reason_ciphertext_check',
        ],
        [
          'a reason above the bound',
          { change_reason_ciphertext: `v1.${'A'.repeat(4094)}` },
          'change_reason_ciphertext_check',
        ],
        [
          'a reason that is not an envelope',
          { change_reason_ciphertext: 'plain reason text that is long enough to pass the length' },
          'change_reason_ciphertext_check',
        ],
        [
          'an expert reference below the shortest envelope',
          {
            subject_kind: 'issuer-reactivation',
            proposed_revision_id: null,
            proposed_expert_reference_ciphertext: 'v1.short',
          },
          'expert_reference_ciphertext_check',
        ],
        [
          'an expert reference above the bound',
          {
            subject_kind: 'issuer-reactivation',
            proposed_revision_id: null,
            proposed_expert_reference_ciphertext: `v1.${'A'.repeat(4094)}`,
          },
          'expert_reference_ciphertext_check',
        ],
        [
          'an expert reference that is not an envelope',
          {
            subject_kind: 'issuer-reactivation',
            proposed_revision_id: null,
            proposed_expert_reference_ciphertext: 'plain text expert reference of enough length 1',
          },
          'expert_reference_ciphertext_check',
        ],
        [
          'a pending proposal with a decider',
          { decided_by_account_id: uuid7() },
          'decided_by_check',
        ],
        [
          'an approved proposal without a decision time',
          { state: 'approved', decided_by_account_id: uuid7() },
          'decided_at_check',
        ],
        ['a bad market id', { market_id: 'au' }, 'market_id_check'],
        ['a bad tenant id', { tenant_id: 'Default' }, 'tenant_id_check'],
        ['version zero', { version: 0 }, 'version_check'],
      ])('names the violated check: %s', async (_label, overrides, name) => {
        expect(await insertFailure('relaxation_proposals', proposal(overrides))).toEqual({
          code: '23514',
          constraint: `relaxation_proposals_${name}`,
        });
      });

      it('accepts each valid shape', async () => {
        expect(await insertFailure('relaxation_proposals', proposal())).toBeNull();
        expect(
          await insertFailure(
            'relaxation_proposals',
            proposal({
              subject_kind: 'issuer-reactivation',
              proposed_revision_id: null,
              proposed_expert_reference_ciphertext: CIPHERTEXT,
            }),
          ),
        ).toBeNull();
        expect(
          await insertFailure(
            'relaxation_proposals',
            proposal({ subject_kind: 'type-reactivation', proposed_revision_id: null }),
          ),
        ).toBeNull();
        expect(
          await insertFailure(
            'relaxation_proposals',
            proposal({
              state: 'approved',
              decided_at: T1,
              decided_by_account_id: uuid7(),
              change_reason_ciphertext: CIPHERTEXT,
            }),
          ),
        ).toBeNull();
      });

      it('holds one pending proposal per subject, and a new one once it is decided', async () => {
        const subject = uuid7();
        const first = proposal({ subject_id: subject });
        expect(await insertFailure('relaxation_proposals', first)).toBeNull();
        expect(
          await insertFailure('relaxation_proposals', proposal({ subject_id: subject })),
        ).toEqual({
          code: '23505',
          constraint: 'relaxation_proposals_market_id_subject_pending_key',
        });
        // The same subject id in another Market is another subject.
        expect(
          await insertFailure(
            'relaxation_proposals',
            proposal({ subject_id: subject, ...base(other.marketId, other.tenantId) }),
          ),
        ).toBeNull();
        expect(
          await failure(
            sql,
            `UPDATE certification.relaxation_proposals
              SET state = 'rejected', decided_by_account_id = $2, decided_at = $3, version = 2
            WHERE id = $1`,
            [first.id, uuid7(), T1],
          ),
        ).toBeNull();
        expect(
          await insertFailure('relaxation_proposals', proposal({ subject_id: subject })),
        ).toBeNull();
      });

      it('decides a pending proposal once: a decided one is frozen for every role, the version moves by one (Hassan M1)', async () => {
        const decide = (id: string, state: string, version: number, by = uuid7()) =>
          `UPDATE certification.relaxation_proposals
            SET state = '${state}', decided_by_account_id = ${
              state === 'approved' || state === 'rejected' ? `'${by}'` : 'NULL'
            }, decided_at = '${T1}', version = ${version}
          WHERE id = '${id}'`;
        const pending = proposal();
        await insert('relaxation_proposals', pending);
        // The version must move by exactly one, and the state must leave pending.
        expect((await failure(sql, decide(pending.id, 'approved', 1)))?.code).toBe('23001');
        expect((await failure(sql, decide(pending.id, 'approved', 3)))?.code).toBe('23001');
        expect(
          (
            await failure(
              sql,
              `UPDATE certification.relaxation_proposals SET version = 2 WHERE id = $1`,
              [pending.id],
            )
          )?.code,
        ).toBe('23001');
        expect(await failure(sql, decide(pending.id, 'approved', 2))).toBeNull();
        // A decided proposal is frozen: back to pending, to the other decision, another decider.
        for (const client of [sql, owner]) {
          for (const statement of [
            `UPDATE certification.relaxation_proposals
              SET state = 'pending', decided_by_account_id = NULL, decided_at = NULL, version = 3
            WHERE id = '${pending.id}'`,
            decide(pending.id, 'rejected', 3),
            `UPDATE certification.relaxation_proposals SET decided_by_account_id = '${uuid7()}', version = 3 WHERE id = '${pending.id}'`,
            `UPDATE certification.relaxation_proposals SET decided_at = '${T0}', version = 3 WHERE id = '${pending.id}'`,
          ]) {
            expect((await failure(client, statement))?.code).toBe('23001');
          }
        }
        // The other final states are reachable from pending.
        for (const state of ['withdrawn', 'superseded', 'rejected']) {
          const row = proposal();
          await insert('relaxation_proposals', row);
          expect(await failure(sql, decide(row.id, state, 2))).toBeNull();
        }
      });

      it('lets the application change only the decision columns and never delete', async () => {
        const row = proposal();
        await insert('relaxation_proposals', row);
        for (const column of ['subject_id', 'proposer_account_id', 'proposed_at', 'subject_kind']) {
          const result = await failure(
            sql,
            `UPDATE certification.relaxation_proposals SET ${column} = ${column} WHERE id = $1`,
            [row.id],
          );
          expect(result?.code).toBe('42501');
        }
        expect(
          (
            await failure(sql, `DELETE FROM certification.relaxation_proposals WHERE id = $1`, [
              row.id,
            ])
          )?.code,
        ).toBe('42501');
      });
    });

    describe('platform subject keys', () => {
      it('holds one subject per Market, never changed', async () => {
        const subjectId = uuid7();
        const row = { ...base(), subject_id: subjectId, created_at: T0 };
        // Another test file or run may already hold the Market's row; use a throwaway Market code.
        const throwaway = {
          ...row,
          market_id: `T${Date.now().toString(36).toUpperCase().slice(-6)}`,
        };
        for (const [overrides, name] of [
          [{ market_id: 'au' }, 'market_id_check'],
          [{ tenant_id: 'Default' }, 'tenant_id_check'],
        ] as const) {
          expect(await insertFailure('platform_subjects', { ...throwaway, ...overrides })).toEqual({
            code: '23514',
            constraint: `platform_subjects_${name}`,
          });
        }
        expect(await insertFailure('platform_subjects', throwaway)).toBeNull();
        expect(await insertFailure('platform_subjects', throwaway)).toEqual({
          code: '23505',
          constraint: 'platform_subjects_pkey',
        });
        expect(
          (
            await failure(
              sql,
              `UPDATE certification.platform_subjects SET subject_id = $2 WHERE market_id = $1`,
              [throwaway.market_id, uuid7()],
            )
          )?.code,
        ).toBe('42501');
        expect(
          (
            await failure(sql, `DELETE FROM certification.platform_subjects WHERE market_id = $1`, [
              throwaway.market_id,
            ])
          )?.code,
        ).toBe('42501');
        expect(
          await failure(owner, `DELETE FROM certification.platform_subjects WHERE market_id = $1`, [
            throwaway.market_id,
          ]),
        ).toBeNull();
      });
    });

    describe('the reason ciphertext of a revision (4.4)', () => {
      it('is NULL or a bounded envelope', async () => {
        const { typeId } = await type();
        const revision = (n: number, reason: string | null) => ({
          id: uuid7(),
          ...base(),
          type_id: typeId,
          revision_no: n,
          verification_mode: 'THIRD_PARTY_DOCUMENT',
          requires_issuer_registry: true,
          requires_document: true,
          requires_expiry: true,
          default_basis: 'SELLER_REQUIRED',
          auto_approve_self_declaration: false,
          badge_icon_key: 'halal',
          author_account_id: uuid7(),
          created_at: T0,
          change_reason_ciphertext: reason,
        });
        expect(await insertFailure('certification_type_revisions', revision(2, null))).toBeNull();
        expect(
          await insertFailure('certification_type_revisions', revision(3, `v1.${'A'.repeat(38)}`)),
        ).toBeNull();
        expect(
          await insertFailure(
            'certification_type_revisions',
            revision(4, `v1.${'A'.repeat(4093)}`),
          ),
        ).toBeNull();
        for (const [n, reason] of [
          [5, `v1.${'A'.repeat(37)}`],
          [6, `v1.${'A'.repeat(4094)}`],
          [7, `v1.${'A'.repeat(48)}${BS}`],
          [8, 'plain reason text that is long enough to pass the length check on its own'],
        ] as const) {
          expect(await insertFailure('certification_type_revisions', revision(n, reason))).toEqual({
            code: '23514',
            constraint: 'certification_type_revisions_change_reason_ciphertext_check',
          });
        }
      });
    });
  });
}
