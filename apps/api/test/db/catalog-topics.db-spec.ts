import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  normaliseTopicTerm,
  type TopicState,
  type TopicTerm,
} from '../../src/modules/catalog/domain/topic';
import { PrismaTopicReader } from '../../src/modules/catalog/infrastructure/prisma-topic.reader';
import { PrismaTopicRepository } from '../../src/modules/catalog/infrastructure/prisma-topic.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { sqlState } from './sql-state';
import { testDatabaseUrl } from './test-database';

// The topic list of package T1 on PostgreSQL, for both Market fixtures: the CHECKs of the two
// tables (a name only at position 0), the repository (terms replaced as a set, unique slug per
// Market, unique normalised term per Market and locale across topics, optimistic version), the
// reader (filters, search on text and key, keyset paging), Market isolation and the grants. Each
// case builds its own topics under words nobody else uses.

const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-07T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const tag = (): string => randomUUID().replaceAll('-', '').slice(0, 10);
const letters = (value: string): string =>
  value.replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]!);

const term = (locale: string, kind: TopicTerm['kind'], text: string): TopicTerm => ({
  locale,
  kind,
  text,
  key: normaliseTopicTerm(text),
});

describe.each(TEST_MARKETS)('catalog topics in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let repository: PrismaTopicRepository;
  let reader: PrismaTopicReader;
  let sql: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaTopicRepository(persistence.service);
    reader = new PrismaTopicReader(persistence.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  const inUnitOf =
    (target: typeof market) =>
    <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });
  const inUnit = inUnitOf(market);

  function topic(unique: string, overrides: Partial<TopicState> = {}): TopicState {
    return {
      id: uuid7() as Id<'Topic'>,
      slug: `t-${unique}`,
      group: 'use',
      status: 'active',
      terms: [term('en', 'name', `Topic ${unique}`)],
      intro: null,
      createdBy: uuid7() as Id<'Account'>,
      createdAt: T0,
      updatedAt: T0,
      version: 1,
      ...overrides,
    };
  }

  it('stores a topic with its names and synonyms in order and reads it back', async () => {
    const unique = letters(tag());
    const state = topic(unique, {
      group: 'cuisine',
      intro: 'Rice and kebab.',
      terms: [
        term('ar', 'name', `طعام ${unique}`),
        term('en', 'name', `Persian ${unique}`),
        term('en', 'synonym', `Iranian ${unique}`),
        term('en', 'synonym', `Farsi ${unique}`),
      ],
    });

    expect(await inUnit(() => repository.add(market, state))).toBeNull();

    expect(await inUnit(() => repository.findById(market, state.id))).toEqual(state);
    expect(await inUnit(() => repository.slugTaken(market, state.slug))).toBe(true);
    expect(await inUnit(() => repository.slugTaken(market, `${state.slug}-x`))).toBe(false);
  });

  it('keeps a topic inside its Market, where the other Market may reuse slug and terms', async () => {
    const unique = letters(tag());
    const state = topic(unique);
    await inUnit(() => repository.add(market, state));

    expect(await inUnitOf(other)(() => repository.findById(other, state.id))).toBeNull();
    expect(await inUnitOf(other)(() => repository.slugTaken(other, state.slug))).toBe(false);
    expect(await inUnitOf(other)(() => repository.add(other, topic(unique)))).toBeNull();
  });

  it('refuses a taken slug and a term another topic uses, as a name or a synonym', async () => {
    const unique = letters(tag());
    const first = topic(unique, {
      terms: [term('en', 'name', `Grill ${unique}`), term('en', 'synonym', `BBQ ${unique}`)],
    });
    expect(await inUnit(() => repository.add(market, first))).toBeNull();

    expect(await inUnit(() => repository.add(market, topic(unique)))).toBe('topic.slug-taken');
    const synonymAsName = topic(`${unique}b`, { terms: [term('en', 'name', `bbq ${unique}!`)] });
    expect(await inUnit(() => repository.add(market, synonymAsName))).toBe('topic.term-taken');
    // The same words in another locale are another term.
    const otherLocale = topic(`${unique}c`, { terms: [term('ar', 'name', `BBQ ${unique}`)] });
    expect(await inUnit(() => repository.add(market, otherLocale))).toBeNull();

    expect(
      await inUnit(() =>
        repository.takenTermKeys(
          market,
          [
            { locale: 'en', key: normaliseTopicTerm(`BBQ ${unique}`) },
            { locale: 'en', key: normaliseTopicTerm(`New ${unique}`) },
            { locale: 'ar', key: normaliseTopicTerm(`BBQ ${unique}`) },
          ],
          otherLocale.id,
        ),
      ),
    ).toEqual([{ locale: 'en', key: normaliseTopicTerm(`BBQ ${unique}`) }]);
    expect(await inUnit(() => repository.takenTermKeys(market, [], null))).toEqual([]);
  });

  it('replaces the terms as a set under the version it was read at', async () => {
    const unique = letters(tag());
    const state = topic(unique, {
      terms: [term('en', 'name', `Ramadan ${unique}`), term('en', 'synonym', `Iftar ${unique}`)],
    });
    await inUnit(() => repository.add(market, state));

    const edited: TopicState = {
      ...state,
      status: 'archived',
      group: 'occasion',
      intro: 'Dates and sweets.',
      // The synonym becomes the name and the old name a synonym: a swap inside one topic.
      terms: [
        term('en', 'name', `Iftar ${unique}`),
        term('en', 'synonym', `Ramadan ${unique}`),
        term('en', 'synonym', `Suhoor ${unique}`),
      ],
      updatedAt: T1,
      version: 2,
    };
    expect(await inUnit(() => repository.save(market, edited, 1))).toBeNull();

    expect(await inUnit(() => repository.findById(market, state.id))).toEqual(edited);
    await expect(
      inUnit(() => repository.save(market, { ...edited, version: 3 }, 1)),
    ).rejects.toBeInstanceOf(StaleAggregateError);
  });

  it('lists by slug with keyset paging, status and group filters and a search on text or key', async () => {
    const unique = letters(tag());
    const states = ['a', 'b', 'c'].map((suffix) =>
      topic(`${unique}-${suffix}`, {
        status: suffix === 'b' ? 'archived' : 'active',
        group: suffix === 'c' ? 'cuisine' : 'use',
        terms: [
          term('ar', 'name', `مطبخ ${unique}${suffix}`),
          term('en', 'name', `Shop ${unique}${suffix}`),
          term('en', 'synonym', `Store ${unique}${suffix}`),
        ],
      }),
    );
    for (const state of states) await inUnit(() => repository.add(market, state));
    const query = { status: null, group: null, search: unique, afterId: null, limit: 2 };

    const page1 = await inUnit(() => reader.list(market, query));
    expect(page1.items.map((i) => i.slug)).toEqual([states[0]!.slug, states[1]!.slug]);
    expect(page1.nextAfterId).toBe(states[1]!.id);
    const page2 = await inUnit(() => reader.list(market, { ...query, afterId: page1.nextAfterId }));
    expect(page2.items.map((i) => i.slug)).toEqual([states[2]!.slug]);
    expect(page2.nextAfterId).toBeNull();

    const archived = await inUnit(() =>
      reader.list(market, { ...query, status: 'archived', limit: 10 }),
    );
    expect(archived.items.map((i) => i.id)).toEqual([states[1]!.id]);
    const cuisine = await inUnit(() =>
      reader.list(market, { ...query, group: 'cuisine', limit: 10 }),
    );
    expect(cuisine.items.map((i) => i.id)).toEqual([states[2]!.id]);
    const bySynonym = await inUnit(() =>
      reader.list(market, { ...query, search: `STORE ${unique}a`, limit: 10 }),
    );
    expect(bySynonym.items.map((i) => i.id)).toEqual([states[0]!.id]);
    const byKey = await inUnit(() =>
      reader.list(market, { ...query, search: `store, ${unique}a!`, limit: 10 }),
    );
    expect(byKey.items.map((i) => i.id)).toEqual([states[0]!.id]);
    const foreign = await inUnitOf(other)(() => reader.list(other, { ...query, limit: 10 }));
    expect(foreign.items).toEqual([]);
  });

  it('refuses an edit that takes another topic’s term, and lets a term move in two edits', async () => {
    const unique = letters(tag());
    const a = topic(`${unique}-a`, {
      terms: [term('en', 'name', `Alpha ${unique}`), term('en', 'synonym', `Shared ${unique}`)],
    });
    const b = topic(`${unique}-b`, { terms: [term('en', 'name', `Beta ${unique}`)] });
    await inUnit(() => repository.add(market, a));
    await inUnit(() => repository.add(market, b));
    const takes = (state: TopicState, terms: TopicTerm[], version: number): TopicState => ({
      ...state,
      terms,
      updatedAt: T1,
      version,
    });

    expect(
      await inUnit(() =>
        repository.save(
          market,
          takes(
            b,
            [term('en', 'name', `Beta ${unique}`), term('en', 'synonym', `shared ${unique}`)],
            2,
          ),
          1,
        ),
      ),
    ).toBe('topic.term-taken');
    expect(
      await inUnit(() =>
        repository.save(market, takes(a, [term('en', 'name', `Alpha ${unique}`)], 2), 1),
      ),
    ).toBeNull();
    expect(
      await inUnit(() =>
        repository.save(
          market,
          takes(
            b,
            [term('en', 'name', `Beta ${unique}`), term('en', 'synonym', `Shared ${unique}`)],
            2,
          ),
          1,
        ),
      ),
    ).toBeNull();
  });

  it('matches a search with % or _ as typed', async () => {
    const unique = letters(tag());
    const plain = topic(`${unique}-p`, { terms: [term('en', 'name', `Fifty off ${unique}`)] });
    await inUnit(() => repository.add(market, plain));
    const query = { status: null, group: null, afterId: null, limit: 10 };

    const percent = await inUnit(() =>
      reader.list(market, { ...query, search: `fifty%${unique}` }),
    );
    const underscore = await inUnit(() =>
      reader.list(market, { ...query, search: `t_${unique}-p` }),
    );

    expect(percent.items.map((i) => i.id)).not.toContain(plain.id);
    expect(underscore.items.map((i) => i.id)).not.toContain(plain.id);
  });

  it('enforces the CHECKs of the two tables', async () => {
    const insertTopic = (overrides: Record<string, unknown>) => {
      const row = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        slug: `chk-${letters(tag())}`,
        topic_group: 'use',
        status: 'active',
        created_by: uuid7(),
        created_at: T0.toString(),
        updated_at: T0.toString(),
        version: 1,
        ...overrides,
      };
      const columns = Object.keys(row);
      return sqlState(
        sql,
        `INSERT INTO catalog.topics (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    expect(await insertTopic({ slug: 'Bad Slug' })).toBe('23514');
    expect(await insertTopic({ slug: `x${'a'.repeat(40)}` })).toBe('23514');
    expect(await insertTopic({ topic_group: 'season' })).toBe('23514');
    expect(await insertTopic({ status: 'merged' })).toBe('23514');
    expect(await insertTopic({ version: 0 })).toBe('23514');
    expect(await insertTopic({ intro: ' padded ' })).toBe('23514');
    expect(await insertTopic({ intro: 'x'.repeat(1001) })).toBe('23514');
    expect(await insertTopic({ tenant_id: 'BAD' })).toBe('23514');

    const state = topic(letters(tag()));
    await inUnit(() => repository.add(market, state));
    const insertTerm = (overrides: Record<string, unknown>) => {
      const row = {
        market_id: market.marketId,
        tenant_id: market.tenantId,
        topic_id: state.id,
        locale: 'fr',
        kind: 'synonym',
        term: `Word ${tag()}`,
        term_key: `word ${tag()}`,
        position: 1,
        ...overrides,
      };
      const columns = Object.keys(row);
      return sqlState(
        sql,
        `INSERT INTO catalog.topic_terms (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    expect(await insertTerm({ locale: 'EN!' })).toBe('23514');
    expect(await insertTerm({ kind: 'alias' })).toBe('23514');
    expect(await insertTerm({ term: ' Padded ' })).toBe('23514');
    expect(await insertTerm({ term: 'x' })).toBe('23514');
    expect(await insertTerm({ term: 'x'.repeat(41) })).toBe('23514');
    expect(await insertTerm({ term_key: '' })).toBe('23514');
    expect(await insertTerm({ term_key: `Upper ${tag()}` })).toBe('23514');
    // A name only at position 0, and position 0 only for a name.
    expect(await insertTerm({ kind: 'name', position: 1 })).toBe('23514');
    expect(await insertTerm({ kind: 'synonym', position: 0 })).toBe('23514');
    expect(await insertTerm({ position: 11 })).toBe('23514');
    // A second name in a locale that has one is the same key.
    expect(await insertTerm({ locale: 'en', kind: 'name', position: 0 })).toBe('23505');
    // A term of another Market's topic: the composite foreign key refuses it.
    expect(await insertTerm({ market_id: other.marketId })).toBe('23503');
  });

  it('never lets the application change a slug or a creator, or delete a topic', async () => {
    const state = topic(letters(tag()));
    await inUnit(() => repository.add(market, state));

    for (const [statement, value] of [
      ['UPDATE catalog.topics SET slug = $2 WHERE id = $1', 'renamed'],
      ['UPDATE catalog.topics SET created_by = $2 WHERE id = $1', uuid7()],
      ['UPDATE catalog.topic_terms SET term = $2 WHERE topic_id = $1', 'Renamed'],
    ] as const) {
      expect(await sqlState(sql, statement, [state.id, value])).toBe('42501');
    }
    expect(await sqlState(sql, 'DELETE FROM catalog.topics WHERE id = $1', [state.id])).toBe(
      '42501',
    );
  });
});
