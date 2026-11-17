import { RAW_READ_STATEMENTS } from './statements';

// `to_tsquery` raises a syntax error on text that is not built for it, so only the suggest
// statements may hold it, and only because `parseSuggestQuery` builds their text from letters and
// digits (ADR-0030 amendment, search 1b). A new statement that wants it is a deliberate review.
describe('to_tsquery in the raw read list', () => {
  it('is used by the three suggest statements and by no other', () => {
    const using = RAW_READ_STATEMENTS.filter((entry) => /\bto_tsquery\b/u.test(entry.sql)).map(
      (entry) => entry.id,
    );
    expect(using.sort()).toEqual([
      'search.offer-suggest',
      'search.offer-suggest-scope-rows',
      'search.store-suggest',
    ]);
  });
});
