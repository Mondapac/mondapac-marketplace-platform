import {
  echoedFieldName,
  MAX_ECHOED_UNKNOWN_FIELDS,
  MORE_FIELDS,
  parseAddressBody,
  parseGeneralBody,
  parseSlugBody,
} from './my-file.body';

describe('parseGeneralBody', () => {
  it('keeps the named fields, null and absent apart', () => {
    expect(parseGeneralBody({ phone: '0400', businessName: null })).toEqual({
      phone: '0400',
      businessName: null,
      storeName: undefined,
      contactEmail: undefined,
    });
  });

  it('refuses a non-object, an array and unknown fields, naming no value', () => {
    expect(parseGeneralBody(null)).toEqual([{ path: '', code: 'type' }]);
    expect(parseGeneralBody([])).toEqual([{ path: '', code: 'type' }]);
    expect(parseGeneralBody({ sellerId: 'secret' })).toEqual([
      { path: 'sellerId', code: 'unknown-field' },
    ]);
  });

  it('echoes at most ten unknown names, then one marker', () => {
    const extra = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, 1]));
    const problems = parseGeneralBody(extra) as readonly { path: string }[];
    expect(problems).toHaveLength(MAX_ECHOED_UNKNOWN_FIELDS + 1);
    expect(problems.at(-1)!.path).toBe(MORE_FIELDS);
  });

  it('counts the length in characters, not code units', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(Array.isArray(parseGeneralBody({ phone: emoji.repeat(512) }))).toBe(false);
    expect(parseGeneralBody({ phone: emoji.repeat(513) })).toEqual([
      { path: 'phone', code: 'length' },
    ]);
  });
});

describe('parseAddressBody', () => {
  it('requires an address object of strings', () => {
    expect(parseAddressBody({})).toEqual([{ path: 'address', code: 'required' }]);
    expect(parseAddressBody({ address: 'x' })).toEqual([{ path: 'address', code: 'type' }]);
    expect(parseAddressBody({ address: { a: 1 } })).toEqual([{ path: 'address', code: 'type' }]);
  });

  it('bounds the number of address fields', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(parseAddressBody({ address: many })).toEqual([{ path: 'address', code: 'length' }]);
  });

  it('never echoes a caller key: a control-character or 65-code-point key', () => {
    const odd = `bad${String.fromCharCode(7)}key`;
    const long = 'k'.repeat(65);
    const problems = parseAddressBody({
      address: { [odd]: 1, [long]: 'v' },
      registeredAddress: { [odd]: 'x'.repeat(300) },
    });
    expect(problems).toEqual([
      { path: 'address', code: 'type' },
      { path: 'address', code: 'length' },
      { path: 'registeredAddress', code: 'length' },
    ]);
    expect(JSON.stringify(problems)).not.toContain('bad');
  });

  it('keeps a __proto__ key as an own entry for the domain to refuse', () => {
    const body = JSON.parse('{"address":{"__proto__":"x","line1":"y"}}') as unknown;
    const parsed = parseAddressBody(body) as { address: Record<string, string> };
    expect(Object.keys(parsed.address).sort()).toEqual(['__proto__', 'line1']);
    expect(Object.getPrototypeOf(parsed.address)).toBeNull();
  });

  it('omits what the body does not carry', () => {
    expect(parseAddressBody({ address: { a: 'b' } })).toEqual({ address: { a: 'b' } });
  });
});

describe('parseSlugBody', () => {
  it('requires a string slug within the bound', () => {
    expect(parseSlugBody({ slug: 'a-shop' })).toEqual({ slug: 'a-shop' });
    expect(parseSlugBody({})).toEqual([{ path: 'slug', code: 'required' }]);
    expect(parseSlugBody({ slug: 1 })).toEqual([{ path: 'slug', code: 'type' }]);
    expect(parseSlugBody({ slug: 'a'.repeat(101) })).toEqual([{ path: 'slug', code: 'length' }]);
  });
});

describe('echoedFieldName', () => {
  it('replaces control characters and cuts to 64 code points', () => {
    expect(echoedFieldName(`a${String.fromCharCode(0)}b`)).toBe(
      `a${String.fromCodePoint(0xfffd)}b`,
    );
    expect(Array.from(echoedFieldName('x'.repeat(100)))).toHaveLength(64);
  });
});
