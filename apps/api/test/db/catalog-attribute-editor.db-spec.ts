import { err, ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { AttributeCodeTakenError } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import {
  AttributeDefinition,
  DEFAULT_DISPLAY_SETTINGS,
} from '../../src/modules/catalog/domain/attribute-definition';
import { PrismaAttributeDefinitionStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-definition.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The attribute editor's store on PostgreSQL (attributes plan, package A2), for both Market
// fixtures, as the API role: a draft with its first revision, display settings and author; the
// next revision behind the version, and a stale write that leaves nothing behind; publish and
// discard; a code race; the Market boundary; and the hand-written constraints of the migration
// (draft status, help text an object, note length, a value never merged into itself). Each test
// works on its own codes, because other specs share the database.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `a${uuid7().replaceAll('-', '').slice(-10)}`;

describe.each(TEST_MARKETS)('catalog attribute editor store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const author = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let store: PrismaAttributeDefinitionStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaAttributeDefinitionStore(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const draftOf = (codeName: string) => {
    const built = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: codeName,
      dataType: 'select',
      localizable: false,
      material: false,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Pack size' },
      options: [{ code: 'g500', labels: { [locale]: '500 g' }, active: true, position: 0 }],
      display: {
        ...DEFAULT_DISPLAY_SETTINGS,
        helpText: { [locale]: 'Net weight' },
        searchable: true,
        internalNote: 'Only for admins',
        position: 3,
      },
      now: T0,
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };

  it('adds a draft and reads it back with its settings, author and Market', async () => {
    const draft = draftOf(unique());
    await write(market, () => store.addDraft(market, draft, author));
    const found = await read(market, () => store.findById(market, draft.state.id));
    expect(found?.state).toEqual({
      ...draft.state,
      options: [{ ...draft.state.options[0]!, mergedInto: null }],
    });
    const { rows } = await owner.query<{ author_kind: string; author_account_id: string }>(
      'SELECT author_kind, author_account_id FROM catalog.attribute_definition_revisions WHERE id = $1',
      [draft.state.revisionId],
    );
    expect(rows).toEqual([{ author_kind: 'admin', author_account_id: author }]);
    expect(await read(market, () => store.codeTaken(market, draft.state.code))).toBe(true);
    expect(await read(other, () => store.findById(other, draft.state.id))).toBeNull();
    expect(await read(other, () => store.codeTaken(other, draft.state.code))).toBe(false);
  });

  it('saves the next revision behind the version; a stale write leaves nothing behind', async () => {
    const draft = draftOf(unique());
    await write(market, () => store.addDraft(market, draft, author));
    const revise = (from: AttributeDefinition) => {
      const next = from.revise({
        revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
        names: { [locale]: 'Pack' },
        material: true,
        isVariantOption: false,
        bounds: {},
        options: [
          ...from.state.options,
          { code: 'kg1', labels: { [locale]: '1 kg' }, active: false, position: 1 },
        ],
        display: from.state.display,
        now: T0.add({ minutes: 1 }),
      });
      if (!next.ok) throw new Error(next.error.code);
      return next.value;
    };
    const second = revise(draft);
    await write(market, () => store.saveRevision(market, second, author));
    const found = await read(market, () => store.findById(market, draft.state.id));
    expect(found?.state).toMatchObject({ version: 2, revisionNo: 2, material: true });
    expect(found?.state.options.map((o) => [o.code, o.active])).toEqual([
      ['g500', true],
      ['kg1', false],
    ]);

    // Built from the old state: same revision number and an old version.
    const stale = revise(draft);
    const outcome = await db.unitOfWork
      .run(market, async () => ok(await store.saveRevision(market, stale, author)))
      .catch((error: unknown) => err(error));
    expect(outcome.ok ? null : outcome.error).toBeInstanceOf(StaleAggregateError);
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM catalog.attribute_definition_revisions WHERE definition_id = $1',
      [draft.state.id],
    );
    expect(rows[0]?.n).toBe('2');
  });

  it('publishes and discards behind the version', async () => {
    const draft = draftOf(unique());
    await write(market, () => store.addDraft(market, draft, author));
    const published = draft.publish(locale);
    if (!published.ok) throw new Error(published.error.code);
    await write(market, () => store.saveStatus(market, published.value));
    expect((await read(market, () => store.findById(market, draft.state.id)))?.state).toMatchObject(
      { status: 'active', version: 2 },
    );
    const again = draft.discard();
    if (!again.ok) throw new Error(again.error.code);
    await expect(
      db.unitOfWork.run(market, async () => ok(await store.saveStatus(market, again.value))),
    ).rejects.toBeInstanceOf(StaleAggregateError);

    const other = draftOf(unique());
    await write(market, () => store.addDraft(market, other, author));
    const discarded = other.discard();
    if (!discarded.ok) throw new Error(discarded.error.code);
    await write(market, () => store.saveStatus(market, discarded.value));
    expect((await read(market, () => store.findById(market, other.state.id)))?.state.status).toBe(
      'archived',
    );
  });

  it('answers a code taken by a concurrent draft with AttributeCodeTakenError', async () => {
    const codeName = unique();
    await write(market, () => store.addDraft(market, draftOf(codeName), author));
    await expect(
      db.unitOfWork.run(market, async () =>
        ok(await store.addDraft(market, draftOf(codeName), author)),
      ),
    ).rejects.toBeInstanceOf(AttributeCodeTakenError);
  });

  it('keeps the constraints of the migration', async () => {
    const draft = draftOf(unique());
    await write(market, () => store.addDraft(market, draft, author));
    const revisionRow = (overrides: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        definition_id: draft.state.id,
        revision_no: 50 + sequence++,
        material: false,
        is_variant_option: false,
        bounds: '{}',
        names: JSON.stringify({ [locale]: 'X' }),
        author_kind: 'seed',
        created_at: new Date(),
        ...overrides,
      };
      const columns = Object.keys(row);
      return owner.query(
        `INSERT INTO catalog.attribute_definition_revisions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    await expect(revisionRow({ help_text: '[]' })).rejects.toThrow(/help_text_check/);
    await expect(revisionRow({ internal_note: 'x'.repeat(1001) })).rejects.toThrow(
      /internal_note_check/,
    );
    await expect(revisionRow({ internal_note: '' })).rejects.toThrow(/internal_note_check/);
    await expect(revisionRow({ position: -1 })).rejects.toThrow(/position_check/);
    await expect(
      owner.query(
        `INSERT INTO catalog.attribute_definition_revision_options
           (market_id, tenant_id, revision_id, option_code, labels, active, position, merged_into)
         VALUES ($1, $2, $3, 'same', '{"x":"y"}', true, 5, 'same')`,
        [market.marketId, market.tenantId, draft.state.revisionId],
      ),
    ).rejects.toThrow(/merged_into_check/);
    await expect(
      owner.query('UPDATE catalog.attribute_definitions SET status = $1 WHERE id = $2', [
        'pending',
        draft.state.id,
      ]),
    ).rejects.toThrow(/status_check/);
  });
});
