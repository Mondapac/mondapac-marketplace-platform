import {
  parseSourceAddress,
  parseSourceName,
  parseSourceTimeZone,
  SOURCE_ADDRESS_FIELDS_MAX,
  SOURCE_ADDRESS_VALUE_MAX,
  SOURCE_NAME_MAX,
} from './source-text';

describe('parseSourceName', () => {
  it('trims, normalises and accepts 1 to 80 code points', () => {
    expect(parseSourceName('  Brisbane storeroom ')).toEqual({
      ok: true,
      value: 'Brisbane storeroom',
    });
    expect(parseSourceName('é')).toEqual({ ok: true, value: 'é' });
    expect(parseSourceName('a'.repeat(SOURCE_NAME_MAX)).ok).toBe(true);
    expect(parseSourceName('😀'.repeat(SOURCE_NAME_MAX)).ok).toBe(true);
  });

  it.each([
    ['', 'length'],
    ['   ', 'length'],
    ['a'.repeat(SOURCE_NAME_MAX + 1), 'length'],
    ['bad\u0000name', 'characters'],
    ['tab\there', 'characters'],
    ['rtl‮override', 'characters'],
    ['mark‏here', 'characters'],
    [42, 'type'],
    [null, 'type'],
    [undefined, 'type'],
  ])('refuses %j with rule %s', (raw, rule) => {
    expect(parseSourceName(raw)).toEqual({ ok: false, error: { rule } });
  });
});

describe('parseSourceAddress', () => {
  it('accepts a flat object of text fields and freezes the clean copy', () => {
    const parsed = parseSourceAddress({
      line1: ' 1 Test St ',
      suburb: 'Brisbane',
      postcode: '4000',
    });
    expect(parsed).toEqual({
      ok: true,
      value: { line1: '1 Test St', suburb: 'Brisbane', postcode: '4000' },
    });
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', ['a']],
    ['a string', 'x'],
  ])('refuses %s as the wrong type', (_label, raw) => {
    expect(parseSourceAddress(raw)).toEqual({ ok: false, error: { rule: 'type' } });
  });

  it('refuses no fields, too many fields and a bad key', () => {
    expect(parseSourceAddress({})).toEqual({ ok: false, error: { rule: 'fields' } });
    // An object with no own text fields (a Date) is no address.
    expect(parseSourceAddress(new Date())).toEqual({ ok: false, error: { rule: 'fields' } });
    const many = Object.fromEntries(
      Array.from({ length: SOURCE_ADDRESS_FIELDS_MAX + 1 }, (_, i) => [`f${i}`, 'x']),
    );
    expect(parseSourceAddress(many)).toEqual({ ok: false, error: { rule: 'fields' } });
    for (const key of ['Line1', '1line', 'a-b', '__proto__x', 'a'.repeat(33)]) {
      expect(parseSourceAddress({ [key]: 'x' })).toEqual({ ok: false, error: { rule: 'fields' } });
    }
  });

  it('names the field of a bad value, never the value', () => {
    expect(parseSourceAddress({ line1: '' })).toEqual({
      ok: false,
      error: { rule: 'length', field: 'line1' },
    });
    expect(parseSourceAddress({ line1: 'x'.repeat(SOURCE_ADDRESS_VALUE_MAX + 1) })).toEqual({
      ok: false,
      error: { rule: 'length', field: 'line1' },
    });
    expect(parseSourceAddress({ line1: 'a\u0007b' })).toEqual({
      ok: false,
      error: { rule: 'characters', field: 'line1' },
    });
    expect(parseSourceAddress({ line1: 5 })).toEqual({
      ok: false,
      error: { rule: 'type', field: 'line1' },
    });
  });

  it('does not let an inherited or own __proto__ value through', () => {
    const polluted = JSON.parse('{"__proto__": {"x": "y"}, "line1": "a"}') as unknown;
    expect(parseSourceAddress(polluted)).toEqual({ ok: false, error: { rule: 'fields' } });
  });
});

describe('parseSourceTimeZone', () => {
  it('accepts a zone the runtime knows and refuses the rest', () => {
    expect(parseSourceTimeZone('Australia/Brisbane')).toEqual({
      ok: true,
      value: 'Australia/Brisbane',
    });
    expect(parseSourceTimeZone('Mars/Olympus').ok).toBe(false);
    expect(parseSourceTimeZone('').ok).toBe(false);
    expect(parseSourceTimeZone(5)).toEqual({ ok: false, error: { rule: 'type' } });
  });
});
