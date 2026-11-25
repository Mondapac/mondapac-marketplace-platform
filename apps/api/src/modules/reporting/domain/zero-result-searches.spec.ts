import type { MarketDay } from './facts';
import {
  keptZeroResultRows,
  MIN_ZERO_RESULT_SEARCHERS,
  TOP_ZERO_RESULT_QUERIES,
  zeroResultSearchesOf,
  type ZeroResultSearchDay,
} from './zero-result-searches';

const day = (text: string) => text as MarketDay;
const range = { from: day('2026-11-01'), to: day('2026-11-30') };
const row = (
  d: string,
  query: string,
  searchers: number,
  searches: number,
): ZeroResultSearchDay => ({
  day: day(d),
  query,
  searchers,
  searches,
});

describe('zeroResultSearchesOf: the top zero-result queries of a period', () => {
  it('is not-enough-data when no query reached the minimum on a recorded day', () => {
    expect(zeroResultSearchesOf([], new Set([day('2026-11-02')]), range)).toEqual({
      status: 'not-enough-data',
      minimumSearchers: MIN_ZERO_RESULT_SEARCHERS,
      recordedDays: 1,
      periodDays: 30,
    });
    expect(MIN_ZERO_RESULT_SEARCHERS).toBe(10);
  });

  it('sums each query over its days, most searches first, then by text', () => {
    const answer = zeroResultSearchesOf(
      [
        row('2026-11-02', 'sangak bread', 12, 30),
        row('2026-11-03', 'sangak bread', 10, 14),
        row('2026-11-03', 'barberry', 15, 44),
        row('2026-11-04', 'sumac', 11, 44),
      ],
      new Set([day('2026-11-02'), day('2026-11-03'), day('2026-11-04')]),
      range,
    );
    expect(answer).toEqual({
      status: 'available',
      queries: [
        { query: 'barberry', searches: 44, searcherDays: 15, days: 1 },
        { query: 'sangak bread', searches: 44, searcherDays: 22, days: 2 },
        { query: 'sumac', searches: 44, searcherDays: 11, days: 1 },
      ],
      recordedDays: 3,
      periodDays: 30,
    });
  });

  it('never shows a row below the minimum, even if one was stored', () => {
    const answer = zeroResultSearchesOf(
      [row('2026-11-02', 'jane smith', MIN_ZERO_RESULT_SEARCHERS - 1, 40)],
      new Set([day('2026-11-02')]),
      range,
    );
    expect(answer.status).toBe('not-enough-data');
  });

  it('shows at most the top ten', () => {
    const rows = Array.from({ length: TOP_ZERO_RESULT_QUERIES + 3 }, (_, n) =>
      row('2026-11-02', `query ${String.fromCharCode(97 + n)}`, 10, 100 - n),
    );
    const answer = zeroResultSearchesOf(rows, new Set([day('2026-11-02')]), range);
    expect(answer.status === 'available' && answer.queries).toHaveLength(TOP_ZERO_RESULT_QUERIES);
    expect(answer.status === 'available' && answer.queries[0]?.query).toBe('query a');
  });

  it('counts only the recorded days inside the period', () => {
    const answer = zeroResultSearchesOf(
      [row('2026-11-02', 'barberry', 10, 10)],
      new Set([day('2026-10-31'), day('2026-11-02')]),
      range,
    );
    expect(answer.recordedDays).toBe(1);
  });
});

describe('keptZeroResultRows: what the snapshot writes of the owners’ answer', () => {
  it('keeps only well-formed rows at or above the minimum, once per text', () => {
    expect(
      keptZeroResultRows([
        { query: 'barberry', searchers: 10, searches: 12 },
        { query: 'barberry', searchers: 11, searches: 15 },
        { query: 'nine people', searchers: 9, searches: 30 },
        { query: 'Upper Case', searchers: 10, searches: 10 },
        { query: 'x', searchers: 10, searches: 10 },
        { query: 'y'.repeat(51), searchers: 10, searches: 10 },
        { query: 'odd counts', searchers: 12, searches: 11 },
        { query: 'sumac', searchers: 10.5, searches: 11 },
      ]),
    ).toEqual([{ query: 'barberry', searchers: 10, searches: 12 }]);
  });
});
