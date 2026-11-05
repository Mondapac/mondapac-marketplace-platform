import { SequenceIdGenerator, FixedClock } from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { allActivityIds, parseActivityChange, sameAssignment } from './seller-business-activities';

const ids = new SequenceIdGenerator(new FixedClock(Temporal.Instant.from('2026-11-02T00:00:00Z')));
const activity = (): Id<'BusinessActivity'> => ids.next<'BusinessActivity'>();

describe('parseActivityChange', () => {
  it('accepts one main, no extras and a trimmed reason', () => {
    const main = activity();
    const result = parseActivityChange({
      mainActivityId: main,
      extraActivityIds: [],
      reason: '  Seller asked for it  ',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        assignment: { mainActivityId: main, extraActivityIds: [] },
        reason: 'Seller asked for it',
      },
    });
  });

  it('keeps nine extras in ascending order', () => {
    const main = activity();
    const extras = Array.from({ length: 9 }, activity);
    const result = parseActivityChange({
      mainActivityId: main,
      extraActivityIds: [...extras].reverse(),
      reason: 'x',
    });
    expect(result.ok && result.value.assignment.extraActivityIds).toEqual([...extras].sort());
  });

  it.each([
    ['not an object', 'x', [{ path: '', code: 'type' }]],
    ['an array', [], [{ path: '', code: 'type' }]],
    [
      'nothing',
      {},
      [
        { path: 'mainActivityId', code: 'required' },
        { path: 'extraActivityIds', code: 'required' },
        { path: 'reason', code: 'required' },
      ],
    ],
    [
      'a bad main id and a numeric reason',
      { mainActivityId: 'nope', extraActivityIds: [], reason: 5 },
      [
        { path: 'mainActivityId', code: 'format' },
        { path: 'reason', code: 'type' },
      ],
    ],
    [
      'a blank reason',
      {
        mainActivityId: '0194c0de-0000-7000-8000-000000000001',
        extraActivityIds: [],
        reason: '  ',
      },
      [{ path: 'reason', code: 'required' }],
    ],
    [
      'a reason over 300 characters',
      {
        mainActivityId: '0194c0de-0000-7000-8000-000000000001',
        extraActivityIds: [],
        reason: 'a'.repeat(301),
      },
      [{ path: 'reason', code: 'length' }],
    ],
    [
      'a control character in the reason',
      {
        mainActivityId: '0194c0de-0000-7000-8000-000000000001',
        extraActivityIds: [],
        reason: 'a\u0000b',
      },
      [{ path: 'reason', code: 'characters' }],
    ],
    [
      'an unknown field',
      {
        mainActivityId: '0194c0de-0000-7000-8000-000000000001',
        extraActivityIds: [],
        reason: 'x',
        status: 'x',
      },
      [{ path: 'status', code: 'unknown-field' }],
    ],
    [
      'extras that are not a list',
      {
        mainActivityId: '0194c0de-0000-7000-8000-000000000001',
        extraActivityIds: 'a',
        reason: 'x',
      },
      [{ path: 'extraActivityIds', code: 'type' }],
    ],
  ])('refuses %s', (_name, body, fields) => {
    expect(parseActivityChange(body)).toEqual({ ok: false, error: fields });
  });

  it('refuses ten extras, a repeated extra and the main id among the extras', () => {
    const main = activity();
    const other = activity();
    expect(
      parseActivityChange({
        mainActivityId: main,
        extraActivityIds: Array.from({ length: 10 }, activity),
        reason: 'x',
      }),
    ).toEqual({ ok: false, error: [{ path: 'extraActivityIds', code: 'length' }] });
    expect(
      parseActivityChange({
        mainActivityId: main,
        extraActivityIds: [other, other, main],
        reason: 'x',
      }),
    ).toEqual({
      ok: false,
      error: [
        { path: 'extraActivityIds.1', code: 'duplicate' },
        { path: 'extraActivityIds.2', code: 'duplicate' },
      ],
    });
  });
});

describe('assignment helpers', () => {
  it('compares equal sets and lists the main activity first', () => {
    const [a, b, c] = [activity(), activity(), activity()];
    expect(
      sameAssignment(
        { mainActivityId: a, extraActivityIds: [b, c] },
        { mainActivityId: a, extraActivityIds: [b, c] },
      ),
    ).toBe(true);
    expect(
      sameAssignment(
        { mainActivityId: a, extraActivityIds: [b] },
        { mainActivityId: b, extraActivityIds: [a] },
      ),
    ).toBe(false);
    expect(
      sameAssignment(
        { mainActivityId: null, extraActivityIds: [] },
        { mainActivityId: a, extraActivityIds: [] },
      ),
    ).toBe(false);
    expect(allActivityIds({ mainActivityId: b, extraActivityIds: [a, c] })).toEqual([b, a, c]);
    expect(allActivityIds({ mainActivityId: null, extraActivityIds: [] })).toEqual([]);
  });
});
