import {
  clockOf,
  parseDeliveryTerms,
  sameTerms,
  termsOfStored,
  termsTextOf,
} from './delivery-terms';

const terms = (over: Record<string, unknown> = {}) => ({
  day: 'next-day',
  from: '08:00',
  to: '12:00',
  cutoff: '14:00',
  ...over,
});

describe('parseDeliveryTerms', () => {
  it('reads the four fields as minutes since local midnight', () => {
    expect(parseDeliveryTerms(terms())).toEqual({
      ok: true,
      value: { day: 'next-day', fromMinute: 480, toMinute: 720, cutoffMinute: 840 },
    });
  });

  it('clears with null or absent', () => {
    expect(parseDeliveryTerms(null)).toEqual({ ok: true, value: null });
    expect(parseDeliveryTerms(undefined)).toEqual({ ok: true, value: null });
  });

  it('accepts a window that ends at the end of the day, but not one that starts there', () => {
    expect(
      parseDeliveryTerms(terms({ from: '18:00', to: '24:00', cutoff: '09:00' })),
    ).toMatchObject({
      ok: true,
      value: { toMinute: 1440 },
    });
    expect(parseDeliveryTerms(terms({ from: '24:00', to: '24:00' }))).toEqual({
      ok: false,
      error: { code: 'delivery.window' },
    });
  });

  it.each([['daily'], [''], [7], [null], [undefined]])('refuses the day %p', (day) => {
    expect(parseDeliveryTerms(terms({ day }))).toEqual({
      ok: false,
      error: { code: 'delivery.day' },
    });
  });

  it.each([[[]], ['same-day'], [5]])('refuses a value that is not an object: %p', (value) => {
    expect(parseDeliveryTerms(value)).toEqual({ ok: false, error: { code: 'delivery.day' } });
  });

  it.each([
    ['a time that is not a half hour', { from: '08:15' }],
    ['a time with seconds', { to: '12:00:00' }],
    ['a time past 24:00', { to: '24:30' }],
    ['a time that is not a time', { from: 'morning' }],
    ['a number', { from: 800 }],
    ['a window that opens at its close', { from: '12:00', to: '12:00' }],
    ['a window that closes before it opens', { from: '12:00', to: '08:00' }],
  ])('refuses %s as delivery.window', (_, over) => {
    expect(parseDeliveryTerms(terms(over))).toEqual({
      ok: false,
      error: { code: 'delivery.window' },
    });
  });

  it.each([
    ['a cut-off that is not a half hour', { cutoff: '14:10' }],
    ['a cut-off at the end of the day', { cutoff: '24:00' }],
    ['no cut-off', { cutoff: undefined }],
    ['a same-day cut-off at the window close', { day: 'same-day', cutoff: '12:00' }],
    ['a same-day cut-off after the window closes', { day: 'same-day', cutoff: '13:00' }],
  ])('refuses %s as delivery.cutoff', (_, over) => {
    expect(parseDeliveryTerms(terms(over))).toEqual({
      ok: false,
      error: { code: 'delivery.cutoff' },
    });
  });

  it('lets a next-day cut-off fall after the window, and a same-day one before it closes', () => {
    expect(parseDeliveryTerms(terms({ cutoff: '23:30' })).ok).toBe(true);
    expect(parseDeliveryTerms(terms({ day: 'same-day', cutoff: '11:30' })).ok).toBe(true);
  });
});

describe('stored terms', () => {
  it('round-trips through the text form', () => {
    const parsed = parseDeliveryTerms(terms({ to: '24:00' }));
    if (!parsed.ok || parsed.value === null) throw new Error('parse');
    expect(termsTextOf(parsed.value)).toEqual(terms({ to: '24:00' }));
    expect(clockOf(0)).toBe('00:00');
    expect(clockOf(1410)).toBe('23:30');
  });

  it('rebuilds from the four columns, and null unless all are set and the day is known', () => {
    const row = { day: 'same-day', fromMinute: 480, toMinute: 720, cutoffMinute: 420 };
    expect(termsOfStored(row)).toEqual({ ...row });
    expect(termsOfStored({ ...row, day: null })).toBeNull();
    expect(termsOfStored({ ...row, cutoffMinute: null })).toBeNull();
    expect(termsOfStored({ ...row, day: 'weekly' })).toBeNull();
  });

  it('compares terms by value, and null only with null', () => {
    const a = { day: 'same-day', fromMinute: 480, toMinute: 720, cutoffMinute: 420 } as const;
    expect(sameTerms(a, { ...a })).toBe(true);
    expect(sameTerms(a, { ...a, cutoffMinute: 450 })).toBe(false);
    expect(sameTerms(null, null)).toBe(true);
    expect(sameTerms(a, null)).toBe(false);
  });
});
