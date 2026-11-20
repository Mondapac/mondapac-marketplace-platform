import { parseFeedback, parseMessagePosition } from './feedback';

describe('parseMessagePosition', () => {
  it.each(['1', '2', '9', '10', '60'])('takes %s', (value) => {
    expect(parseMessagePosition(value)).toEqual({ ok: true, value: Number(value) });
  });

  it.each(['0', '01', '61', '100', '-1', '1.5', '1e1', ' 1', 'a', '', '١'])(
    'refuses %j',
    (value) => {
      expect(parseMessagePosition(value).ok).toBe(false);
    },
  );

  it('refuses a non-string', () => {
    expect(parseMessagePosition(1).ok).toBe(false);
    expect(parseMessagePosition(undefined).ok).toBe(false);
  });
});

describe('parseFeedback', () => {
  it('takes a thumbs up with no reason, and a thumbs down with or without one', () => {
    expect(parseFeedback({ rating: 'up', reason: undefined })).toEqual({
      ok: true,
      value: { rating: 'up', reason: null },
    });
    expect(parseFeedback({ rating: 'up', reason: null })).toEqual({
      ok: true,
      value: { rating: 'up', reason: null },
    });
    expect(parseFeedback({ rating: 'down', reason: undefined })).toEqual({
      ok: true,
      value: { rating: 'down', reason: null },
    });
    for (const reason of ['wrong', 'not-found', 'other']) {
      expect(parseFeedback({ rating: 'down', reason })).toEqual({
        ok: true,
        value: { rating: 'down', reason },
      });
    }
  });

  it('refuses a reason with a thumbs up, an unknown reason, and an unknown rating', () => {
    expect(parseFeedback({ rating: 'up', reason: 'wrong' })).toEqual({
      ok: false,
      error: [{ path: 'reason', code: 'range' }],
    });
    expect(parseFeedback({ rating: 'down', reason: 'rude' })).toEqual({
      ok: false,
      error: [{ path: 'reason', code: 'format' }],
    });
    expect(parseFeedback({ rating: 'meh', reason: undefined })).toEqual({
      ok: false,
      error: [{ path: 'rating', code: 'format' }],
    });
    expect(parseFeedback({ rating: undefined, reason: undefined }).ok).toBe(false);
    expect(parseFeedback({ rating: 5, reason: {} }).ok).toBe(false);
  });
});
