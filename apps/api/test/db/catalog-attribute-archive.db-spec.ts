import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  AttributeDefinition,
  DEFAULT_DISPLAY_SETTINGS,
} from '../../src/modules/catalog/domain/attribute-definition';
import { AttributeRelaxationRequest } from '../../src/modules/catalog/domain/attribute-relaxation-request';
import { PrismaAttributeDefinitionStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-definition.store';
import { PrismaAttributeImpactReader } from '../../src/modules/catalog/infrastructure/prisma-attribute-impact.reader';
import { PrismaAttributeRelaxationStore } from '../../src/modules/catalog/infrastructure/prisma-attribute-relaxation.store';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Merging values, archiving and the archive of a material attribute on PostgreSQL (attributes
// A8; catalog data design 3.5, 3.21), for both Market fixtures, as the API role: a merge is a new
// revision whose "merged into" values survive the round trip; a non-material attribute is archived
// without a request; a material one only with a confirmed archive request of the same definition
// at the version the archive starts from (the guard trigger), and a confirmed clear-material
// request does not do; an archived attribute never changes status again; and the impact read
// counts nothing for an attribute no product uses. Each test works on its own codes, because other
// specs share the database.

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `a${uuid7().replaceAll('-', '').slice(-10)}`;
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog attribute archive in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const first = uuid7() as Id<'Account'>;
  const second = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let definitions: PrismaAttributeDefinitionStore;
  let relaxations: PrismaAttributeRelaxationStore;
  let impact: PrismaAttributeImpactReader;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    definitions = new PrismaAttributeDefinitionStore(db.service);
    relaxations = new PrismaAttributeRelaxationStore(db.service);
    impact = new PrismaAttributeImpactReader(db.service);
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

  const archiveRequest = (definition: AttributeDefinition, kind: 'archive' | 'clear-material') =>
    AttributeRelaxationRequest.open({
      id: uuid7() as Id<'AttributeRelaxationRequest'>,
      marketId: market.marketId,
      definitionId: definition.state.id,
      definitionVersion: definition.state.version,
      kind,
      requestedByAccountId: first,
      now: now(),
    });

  const archived = (definition: AttributeDefinition) => {
    const next = definition.archive();
    if (!next.ok) throw new Error(next.error.code);
    return next.value;
  };

  it('stores a merge as a new revision and reads the "merged into" values back', async () => {
    const definition = await published(false);
    const merged = definition.mergeValues({
      revisionId: uuid7() as Id<'AttributeDefinitionRevision'>,
      source: 'can',
      target: 'tin',
      now: now(),
    });
    if (!merged.ok) throw new Error(merged.error.code);
    await write(market, () => definitions.saveRevision(market, merged.value, second));
    const found = await read(market, () => definitions.findById(market, definition.state.id));
    expect(found?.state.revisionNo).toBe(2);
    expect(found?.state.options.map((o) => [o.code, o.active, o.mergedInto ?? null])).toEqual([
      ['tin', true, null],
      ['can', false, 'tin'],
      ['jar', true, null],
    ]);
    expect(await read(other, () => definitions.findById(other, definition.state.id))).toBeNull();
  });

  it('archives a non-material published attribute without a request, once', async () => {
    const definition = await published(false);
    const next = archived(definition);
    await write(market, () => definitions.saveStatus(market, next));
    const found = await read(market, () => definitions.findById(market, definition.state.id));
    expect(found?.state.status).toBe('archived');
    // An archived definition never changes status again.
    const { rows } = await owner.query<{ status: string }>(
      'SELECT status FROM catalog.attribute_definitions WHERE id = $1',
      [definition.state.id],
    );
    expect(rows).toEqual([{ status: 'archived' }]);
    expect(
      await driverCode(
        owner.query("UPDATE catalog.attribute_definitions SET status = 'active' WHERE id = $1", [
          definition.state.id,
        ]),
      ),
    ).toBe('23001');
  });

  it('archives a material attribute only with a confirmed archive request at its version', async () => {
    const definition = await published(true);
    const next = archived(definition);
    // No request at all.
    expect(await driverCode(write(market, () => definitions.saveStatus(market, next)))).toBe(
      '23514',
    );
    // An open archive request is not enough.
    const request = archiveRequest(definition, 'archive');
    await write(market, () => relaxations.add(market, request));
    expect(await driverCode(write(market, () => definitions.saveStatus(market, next)))).toBe(
      '23514',
    );
    // Confirmed by the second admin, in the unit that archives.
    const confirmed = request.confirm(second, now());
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    await write(market, async () => {
      expect(
        await definitions.lockAtVersion(market, definition.state.id, definition.state.version),
      ).toBe(true);
      await relaxations.saveMove(market, confirmed.value);
      await definitions.saveStatus(market, next);
    });
    const found = await read(market, () => definitions.findById(market, definition.state.id));
    expect(found?.state.status).toBe('archived');
  });

  it('does not archive a material attribute on a confirmed clear-material request', async () => {
    const definition = await published(true);
    const request = archiveRequest(definition, 'clear-material');
    await write(market, () => relaxations.add(market, request));
    const confirmed = request.confirm(second, now());
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    await write(market, () => relaxations.saveMove(market, confirmed.value));
    expect(
      await driverCode(write(market, () => definitions.saveStatus(market, archived(definition)))),
    ).toBe('23514');
  });

  it('counts nothing for an attribute no product, draft, feature set or category uses', async () => {
    const definition = await published(false);
    const answer = await read(market, () =>
      impact.impactOf(market, { code: definition.state.code, isVariantOption: false }),
    );
    expect(answer).toEqual({
      publishedProducts: { count: 0, atLeast: false },
      drafts: { count: 0, atLeast: false },
      featureSetCount: 0,
      featureSets: [],
      categories: { count: 0, atLeast: false },
      filters: { count: 0, atLeast: false },
      liveVariantProducts: { count: 0, atLeast: false },
    });
  });
});
