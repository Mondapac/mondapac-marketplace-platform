import type { MarketContext } from '@mondapac/shared-kernel';
import type { TopicBrief } from '../ports/topic.reader';
import { draftTopicIds, topicRefsOf } from './topic-refs';

// The own-product read looks up published and pending topics first and caps the draft's ids, so a
// draft can never crowd out the names a seller needs to see; draft ids are compared lower case.

const T = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('draftTopicIds', () => {
  it('keeps well-formed ids, lower-cased, and reads anything else as none', () => {
    expect(draftTopicIds({ topicIds: [T(1).toUpperCase(), 'nope', 7, T(2)] })).toEqual([
      T(1),
      T(2),
    ]);
    expect(draftTopicIds({ topicIds: 'x' })).toEqual([]);
    expect(draftTopicIds(undefined)).toEqual([]);
  });
});

describe.each(['AU', 'ZZ'])('topicRefsOf in market %s', (marketId) => {
  const market = { marketId } as unknown as MarketContext;

  it('asks for the ids in the order given, without repeats, and at most 50', async () => {
    const asked: string[][] = [];
    const reader = {
      briefsOf: (_: MarketContext, ids: readonly string[]): Promise<readonly TopicBrief[]> => {
        asked.push([...ids]);
        return Promise.resolve(
          ids.map((id) => ({
            id: id as TopicBrief['id'],
            slug: `s-${id.slice(-2)}`,
            status: 'active' as const,
            names: { xx: `Name ${id.slice(-2)}` },
          })),
        );
      },
    };
    const published = [T(1), T(2)];
    const draft = Array.from({ length: 11 }, (_, i) => T(100 + i).toUpperCase());
    const ids = [...published, ...draftTopicIds({ topicIds: draft }).slice(0, 10)];
    const refs = await topicRefsOf(reader, market, [...ids, T(1)], 'xx');

    expect(asked[0]?.slice(0, 2)).toEqual(published);
    expect(asked[0]).toHaveLength(12);
    expect(asked[0]?.every((id) => id === id.toLowerCase())).toBe(true);
    expect(refs.get(T(1))?.name).toBe('Name 01');

    const many = Array.from({ length: 60 }, (_, i) => T(200 + i));
    await topicRefsOf(reader, market, many, 'xx');
    expect(asked[1]).toHaveLength(50);
  });
});
