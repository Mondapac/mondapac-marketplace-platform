import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  AttributeDefinition,
  DEFAULT_DISPLAY_SETTINGS,
} from '../../src/modules/catalog/domain/attribute-definition';
import { PrismaAttributeDefinitionStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-definition.store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Merging two attributes on PostgreSQL (attributes A8; plan decision ت۶), for both Market
// fixtures, as the API role: the merge writes the archive, the pointer to the target and the map of
// values in one unit; the guard trigger refuses a pointer set without the archive, a second merge,
// a target of another type, an archived target or one that was merged itself; the map is
// insert-only. Each test works on its own codes, because other specs share the database.

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `a${uuid7().replaceAll('-', '').slice(-10)}`;
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog attribute merge in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const first = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let definitions: PrismaAttributeDefinitionStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    definitions = new PrismaAttributeDefinitionStore(db.service);
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
  const driverCode = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'none';
    } catch (error) {
      const e = error as {
        code?: string;
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
        cause?: { code?: string };
      };
      return (
        e.meta?.driverAdapterError?.cause?.originalCode ?? e.cause?.code ?? e.code ?? 'unknown'
      );
    }
  };

  /** A published select attribute with three values (version 2). */
  async function published(material: boolean): Promise<AttributeDefinition> {
    const built = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: unique(),
      dataType: 'select',
      localizable: false,
      material,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Pack type' },
      options: ['tin', 'can', 'jar'].map((value, position) => ({
        code: value,
        labels: { [locale]: value },
        active: true,
        position,
      })),
      display: DEFAULT_DISPLAY_SETTINGS,
      now: now(),
    });
    if (!built.ok) throw new Error(built.error.code);
    await write(market, () => definitions.addDraft(market, built.value, first));
    const live = built.value.publish(locale);
    if (!live.ok) throw new Error(live.error.code);
    await write(market, () => definitions.saveStatus(market, live.value));
    return live.value;
  }

  const merged = (source: AttributeDefinition) => {
    const next = source.archive();
    if (!next.ok) throw new Error(next.error.code);
    return next.value;
  };
  const pointer = async (id: string) =>
    (
      await owner.query<{ merged_into_id: string | null; status: string }>(
        'SELECT merged_into_id, status FROM catalog.attribute_definitions WHERE id = $1',
        [id],
      )
    ).rows[0];

  it('writes the archive, the pointer and the value map in one unit', async () => {
    const source = await published(false);
    const target = await published(false);
    const next = merged(source);
    const plan = ['tin', 'can', 'jar'].map((c) => ({ sourceCode: c, targetCode: c }));
    await write(market, () => definitions.saveMerge(market, next, target.state.id, plan));
    expect(await pointer(source.state.id)).toEqual({
      merged_into_id: target.state.id,
      status: 'archived',
    });
    const rows = await owner.query(
      'SELECT source_code, target_code FROM catalog.attribute_merge_options WHERE source_id = $1 ORDER BY source_code',
      [source.state.id],
    );
    expect(rows.rows).toHaveLength(3);
    expect((await pointer(target.state.id))?.merged_into_id).toBeNull();
  });

  it('refuses a stale source and writes nothing', async () => {
    const source = await published(false);
    const target = await published(false);
    const next = merged(source);
    await write(market, () => definitions.saveMerge(market, next, target.state.id, []));
    const again = await db.unitOfWork
      .run(market, async () => ok(await definitions.saveMerge(market, next, target.state.id, [])))
      .catch((error: unknown) => error);
    expect(String(again)).toMatch(/Stale|stale|attribute-definition/);
  });

  it('refuses a pointer set on an attribute that stays active', async () => {
    const source = await published(false);
    const target = await published(false);
    expect(
      await driverCode(
        owner.query('UPDATE catalog.attribute_definitions SET merged_into_id = $2 WHERE id = $1', [
          source.state.id,
          target.state.id,
        ]),
      ),
    ).toBe('23001');
  });

  it('refuses to move or clear a pointer once set', async () => {
    const source = await published(false);
    const target = await published(false);
    const third = await published(false);
    await write(market, () => definitions.saveMerge(market, merged(source), target.state.id, []));
    expect(
      await driverCode(
        owner.query('UPDATE catalog.attribute_definitions SET merged_into_id = $2 WHERE id = $1', [
          source.state.id,
          third.state.id,
        ]),
      ),
    ).toBe('23001');
    expect(
      await driverCode(
        owner.query(
          'UPDATE catalog.attribute_definitions SET merged_into_id = NULL WHERE id = $1',
          [source.state.id],
        ),
      ),
    ).toBe('23001');
  });

  it('refuses a target that was merged itself, so a chain is one step', async () => {
    const source = await published(false);
    const middle = await published(false);
    const end = await published(false);
    await write(market, () => definitions.saveMerge(market, merged(middle), end.state.id, []));
    expect(
      await driverCode(
        write(market, () => definitions.saveMerge(market, merged(source), middle.state.id, [])),
      ),
    ).not.toBe('none');
    expect((await pointer(source.state.id))?.status).toBe('active');
  });

  it('refuses to archive or merge an attribute that others were merged into', async () => {
    const source = await published(false);
    const middle = await published(false);
    const end = await published(false);
    await write(market, () => definitions.saveMerge(market, merged(source), middle.state.id, []));
    expect(await read(market, () => definitions.hasMergedSources(market, middle.state.id))).toBe(
      true,
    );
    expect(await read(market, () => definitions.hasMergedSources(market, end.state.id))).toBe(
      false,
    );
    expect(
      await driverCode(
        write(market, () => definitions.saveMerge(market, merged(middle), end.state.id, [])),
      ),
    ).not.toBe('none');
    expect(
      await driverCode(write(market, () => definitions.saveStatus(market, merged(middle)))),
    ).not.toBe('none');
    expect((await pointer(middle.state.id))?.status).toBe('active');
  });

  it('refuses a target of another type', async () => {
    const source = await published(false);
    const text = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: unique(),
      dataType: 'text',
      localizable: false,
      material: false,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Note' },
      options: [],
      display: DEFAULT_DISPLAY_SETTINGS,
      now: now(),
    });
    if (!text.ok) throw new Error(text.error.code);
    await write(market, () => definitions.addDraft(market, text.value, first));
    const live = text.value.publish(locale);
    if (!live.ok) throw new Error(live.error.code);
    await write(market, () => definitions.saveStatus(market, live.value));
    expect(
      await driverCode(
        write(market, () => definitions.saveMerge(market, merged(source), live.value.state.id, [])),
      ),
    ).not.toBe('none');
    expect((await pointer(source.state.id))?.status).toBe('active');
  });

  it('refuses an archived target', async () => {
    const source = await published(false);
    const target = await published(false);
    await write(market, () => definitions.saveStatus(market, merged(target)));
    expect(
      await driverCode(
        write(market, () => definitions.saveMerge(market, merged(source), target.state.id, [])),
      ),
    ).not.toBe('none');
  });

  it('keeps the value map insert-only', async () => {
    const source = await published(false);
    const target = await published(false);
    await write(market, () =>
      definitions.saveMerge(market, merged(source), target.state.id, [
        { sourceCode: 'tin', targetCode: 'tin' },
      ]),
    );
    expect(
      await driverCode(
        owner.query(
          "UPDATE catalog.attribute_merge_options SET target_code = 'can' WHERE source_id = $1",
          [source.state.id],
        ),
      ),
    ).not.toBe('none');
    expect(
      await driverCode(
        owner.query('DELETE FROM catalog.attribute_merge_options WHERE source_id = $1', [
          source.state.id,
        ]),
      ),
    ).not.toBe('none');
  });

  it('does not see the pointer of another Market', async () => {
    const source = await published(false);
    const target = await published(false);
    await write(market, () => definitions.saveMerge(market, merged(source), target.state.id, []));
    const seen = await read(other, () => definitions.findById(other, source.state.id));
    expect(seen).toBeNull();
  });
});
