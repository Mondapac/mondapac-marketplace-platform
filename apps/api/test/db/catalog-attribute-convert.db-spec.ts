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

// Converting the type of an attribute on PostgreSQL (attributes A8; plan decision ت۵), for both
// Market fixtures, as the API role: the conversion writes a revision, the new type and the pointer
// in one unit; the guard trigger refuses a type change that is not one of the two listed paths, one
// without a new revision, and one on an attribute others were merged into. Each test works on its
// own codes, because other specs share the database.

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `a${uuid7().replaceAll('-', '').slice(-10)}`;
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog attribute type conversion in market %s (database)', (code) => {
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

  /** A published attribute of the type, at version 2 (a select has three values). */
  async function published(
    dataType: 'select' | 'integer' | 'decimal',
  ): Promise<AttributeDefinition> {
    const built = AttributeDefinition.createDraft({
      id: uuid7() as Id<'AttributeDefinition'>,
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      marketId: market.marketId,
      code: unique(),
      dataType,
      localizable: false,
      material: false,
      isVariantOption: false,
      bounds: {},
      names: { [locale]: 'Pack type' },
      options:
        dataType === 'select'
          ? ['tin', 'can', 'jar'].map((value, position) => ({
              code: value,
              labels: { [locale]: value },
              active: true,
              position,
            }))
          : [],
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

  const convert = (definition: AttributeDefinition, to: string) => {
    const next = definition.convertType({
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      to,
      now: now(),
    });
    if (!next.ok) throw new Error(next.error.code);
    return next.value;
  };
  const row = async (id: string) =>
    (
      await owner.query<{ data_type: string; version: number; revision_no: number }>(
        `SELECT d.data_type, d.version, r.revision_no
           FROM catalog.attribute_definitions d
           JOIN catalog.attribute_definition_revisions r
             ON r.market_id = d.market_id AND r.id = d.published_revision_id
          WHERE d.id = $1`,
        [id],
      )
    ).rows[0];

  it('writes the new type, a new revision and the pointer in one unit', async () => {
    const select = await published('select');
    const number = await published('integer');
    await write(market, () =>
      definitions.saveConversion(market, convert(select, 'multi-select'), first),
    );
    await write(market, () =>
      definitions.saveConversion(market, convert(number, 'decimal'), first),
    );
    expect(await row(select.state.id)).toEqual({
      data_type: 'multi-select',
      version: 3,
      revision_no: 2,
    });
    expect(await row(number.state.id)).toEqual({
      data_type: 'decimal',
      version: 3,
      revision_no: 2,
    });
    const read2 = await read(market, () => definitions.findById(market, select.state.id));
    expect(read2?.state.dataType).toBe('multi-select');
    // The other Market does not see it.
    expect(await read(other, () => definitions.findById(other, select.state.id))).toBeNull();
  });

  it('refuses a stale version and writes nothing', async () => {
    const select = await published('select');
    const next = convert(select, 'multi-select');
    await write(market, () => definitions.saveConversion(market, next, first));
    const again = await db.unitOfWork
      .run(market, async () => ok(await definitions.saveConversion(market, next, first)))
      .catch((error: unknown) => error);
    expect(String(again)).toMatch(/Stale|stale|attribute-definition/);
    expect((await row(select.state.id))?.data_type).toBe('multi-select');
  });

  it('refuses a type change that is not a listed path', async () => {
    const number = await published('decimal');
    const select = await published('select');
    for (const [id, to] of [
      [number.state.id, 'integer'],
      [number.state.id, 'text'],
      [select.state.id, 'text'],
      [select.state.id, 'integer'],
    ] as const) {
      expect(
        await driverCode(
          owner.query('UPDATE catalog.attribute_definitions SET data_type = $2 WHERE id = $1', [
            id,
            to,
          ]),
        ),
      ).not.toBe('none');
    }
    expect((await row(number.state.id))?.data_type).toBe('decimal');
  });

  it('refuses a type change without a new revision', async () => {
    const select = await published('select');
    expect(
      await driverCode(
        owner.query(
          "UPDATE catalog.attribute_definitions SET data_type = 'multi-select' WHERE id = $1",
          [select.state.id],
        ),
      ),
    ).toBe('23001');
    expect((await row(select.state.id))?.data_type).toBe('select');
  });

  it('refuses a type change on an attribute others were merged into', async () => {
    const source = await published('select');
    const target = await published('select');
    const archived = source.archive();
    if (!archived.ok) throw new Error(archived.error.code);
    await write(market, () => definitions.saveMerge(market, archived.value, target.state.id, []));
    const result = await driverCode(
      write(market, () =>
        definitions.saveConversion(market, convert(target, 'multi-select'), first),
      ),
    );
    expect(result).not.toBe('none');
    expect((await row(target.state.id))?.data_type).toBe('select');
  });
});
