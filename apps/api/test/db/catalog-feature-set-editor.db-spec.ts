import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { FeatureSetCodeTakenError } from '../../src/modules/catalog/application/ports/feature-set.store';
import { AttributeFamily } from '../../src/modules/catalog/domain/attribute-family';
import type { FeatureSetContent } from '../../src/modules/catalog/domain/attribute-family';
import { PrismaFeatureSetStore } from '../../src/modules/catalog/infrastructure/prisma-feature-set.store';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The feature-set editor's store on PostgreSQL (attributes plan, package A4), for both Market
// fixtures, as the API role: a family with its first revision, names per locale, groups with names
// and levels, and the author; the next revision behind the version, and a stale write that leaves
// nothing behind; a code race; the Market boundary; that a family written before package A4 reads
// back with empty names; and the hand-written constraint on the names column. Each test works on
// its own codes, because other specs share the database.

const T0 = Temporal.Instant.from('2026-11-03T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const unique = () => `f${uuid7().replaceAll('-', '').slice(-10)}`;

describe.each(TEST_MARKETS)('catalog feature-set store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const locale = code === 'AU' ? 'en-AU' : 'ja-JP';
  const author = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let store: PrismaFeatureSetStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    store = new PrismaFeatureSetStore(db.service);
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

  const entry = (codeName: string, level: 'required' | 'recommended' | 'optional') => ({
    code: codeName,
    level,
    required: level === 'required',
    isVariantOption: false,
  });
  const contentOf = (name: string): FeatureSetContent => ({
    names: { [locale]: name },
    groups: [
      {
        groupCode: 'core',
        names: { [locale]: 'Core' },
        attributes: [entry('brand', 'required'), entry('country-of-origin', 'optional')],
      },
      {
        groupCode: 'details',
        names: { [locale]: 'Details' },
        attributes: [entry('pack-size', 'recommended')],
      },
    ],
  });
  const familyOf = (codeName: string) => {
    const built = AttributeFamily.createByAdmin({
      id: uuid7() as Id<'AttributeFamily'>,
      revisionId: uuid7() as Id<'AttributeFamilyRevision'>,
      marketId: market.marketId,
      code: codeName,
      content: contentOf('Pantry'),
      defaultLocale: locale,
      now: T0,
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };
  const revise = (from: AttributeFamily, name: string) => {
    const next = from.revise({
      revisionId: uuid7() as Id<'AttributeFamilyRevision'>,
      content: contentOf(name),
      defaultLocale: locale,
    });
    if (!next.ok) throw new Error(next.error.code);
    return next.value;
  };

  it('adds a family and reads it back with names, levels, author and Market', async () => {
    const family = familyOf(unique());
    await write(market, () => store.addNew(market, family, author));
    const found = await read(market, () => store.findById(market, family.state.id));
    expect(found?.state).toEqual(family.state);
    const { rows } = await owner.query<{ author_kind: string; author_account_id: string }>(
      'SELECT author_kind, author_account_id FROM catalog.attribute_family_revisions WHERE id = $1',
      [family.state.revisionId],
    );
    expect(rows).toEqual([{ author_kind: 'admin', author_account_id: author }]);
    expect(await read(market, () => store.codeTaken(market, family.state.code))).toBe(true);
    expect(await read(other, () => store.findById(other, family.state.id))).toBeNull();
    expect(await read(other, () => store.codeTaken(other, family.state.code))).toBe(false);
  });

  it('saves the next revision behind the version; a stale write leaves nothing behind', async () => {
    const family = familyOf(unique());
    await write(market, () => store.addNew(market, family, author));
    const second = revise(family, 'Pantry goods');
    await write(market, () => store.saveRevision(market, second, author));
    const found = await read(market, () => store.findById(market, family.state.id));
    expect(found?.state).toMatchObject({
      version: 2,
      revisionNo: 2,
      names: { [locale]: 'Pantry goods' },
    });

    // A second admin who read version 1 saves now: stale, and no third revision row appears.
    const rival = revise(family, 'Rival');
    await expect(
      db.unitOfWork.run(market, async () => {
        await store.saveRevision(market, rival, author);
        return ok(true);
      }),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM catalog.attribute_family_revisions WHERE family_id = $1',
      [family.state.id],
    );
    expect(rows[0]!.n).toBe('2');
  });

  it('refuses a second family with the code', async () => {
    const codeName = unique();
    await write(market, () => store.addNew(market, familyOf(codeName), author));
    await expect(
      db.unitOfWork.run(market, async () => {
        await store.addNew(market, familyOf(codeName), author);
        return ok(true);
      }),
    ).rejects.toBeInstanceOf(FeatureSetCodeTakenError);
  });

  it('reads a family written before package A4 with empty names', async () => {
    const family = familyOf(unique());
    await write(market, () => store.addNew(market, family, author));
    // A revision of the older shape: no names column value, groups without names or levels.
    const legacyId = uuid7();
    await owner.query(
      `INSERT INTO catalog.attribute_family_revisions
         (id, market_id, tenant_id, family_id, revision_no, groups, author_kind, created_at)
       SELECT $1, market_id, tenant_id, family_id, 2, $2::jsonb, 'seed', now()
         FROM catalog.attribute_family_revisions WHERE id = $3`,
      [
        legacyId,
        JSON.stringify([
          {
            groupCode: 'general',
            attributes: [{ code: 'brand', required: true, isVariantOption: false }],
          },
        ]),
        family.state.revisionId,
      ],
    );
    await owner.query(
      'UPDATE catalog.attribute_families SET published_revision_id = $1, version = 2 WHERE id = $2',
      [legacyId, family.state.id],
    );
    const found = await read(market, () => store.findById(market, family.state.id));
    expect(found?.state.names).toEqual({});
    expect(found?.state.groups[0]).toEqual({
      groupCode: 'general',
      attributes: [{ code: 'brand', required: true, isVariantOption: false }],
    });
  });

  it('keeps the names column an object', async () => {
    const family = familyOf(unique());
    await write(market, () => store.addNew(market, family, author));
    await expect(
      owner.query(
        `INSERT INTO catalog.attribute_family_revisions
           (id, market_id, tenant_id, family_id, revision_no, groups, names, author_kind, created_at)
         SELECT $1, market_id, tenant_id, family_id, 9, '[]'::jsonb, '[]'::jsonb, 'seed', now()
           FROM catalog.attribute_family_revisions WHERE id = $2`,
        [uuid7(), family.state.revisionId],
      ),
    ).rejects.toThrow(/attribute_family_revisions_names_check/);
  });
});
