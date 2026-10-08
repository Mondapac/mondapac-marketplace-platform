import { addressFromJson, addressToJson, parseAddress, type AddressFormatSpec } from './address';

// Two Market-shaped formats (AU-like and ZZ-like); the domain knows neither Market.
const FIVE_FIELDS: AddressFormatSpec = {
  fields: [
    { key: 'line1', labelKey: 'l.line1', required: true, maxLength: 120 },
    { key: 'line2', labelKey: 'l.line2', required: false, maxLength: 120 },
    { key: 'suburb', labelKey: 'l.suburb', required: true, maxLength: 120 },
    { key: 'state', labelKey: 'l.state', required: true, maxLength: 3 },
    { key: 'postcode', labelKey: 'l.postcode', required: true, maxLength: 4 },
  ],
  postcodeField: 'postcode',
  regionField: 'state',
  postcodePattern: '^[0-9]{4}$',
  regions: ['NSW', 'QLD'],
};
const NO_REGION: AddressFormatSpec = {
  fields: [
    { key: 'street', labelKey: 'l.street', required: true, maxLength: 120 },
    { key: 'postalCode', labelKey: 'l.postalCode', required: true, maxLength: 8 },
  ],
  postcodeField: 'postalCode',
  regionField: null,
  postcodePattern: '^[0-9]{7}$',
  regions: [],
};

const valid = { line1: ' 1 George St ', suburb: 'Brisbane', state: 'QLD', postcode: '4000' };

describe('parseAddress', () => {
  it('keeps the fields of the format in its order, trimmed, and names the postcode and region', () => {
    const parsed = parseAddress({ ...valid, line2: '' }, FIVE_FIELDS, 'address');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.postcode).toBe('4000');
    expect(parsed.value.region).toBe('QLD');
    expect(Object.keys(parsed.value.fields)).toEqual(['line1', 'suburb', 'state', 'postcode']);
    expect(parsed.value.fields.line1).toBe('1 George St');
  });

  it('answers a Market without a region field with region null', () => {
    const parsed = parseAddress({ street: 'Main 1', postalCode: '1000001' }, NO_REGION, 'address');
    expect(parsed.ok && parsed.value.region).toBeNull();
  });

  it('reports every problem with its path and code, never the value', () => {
    const parsed = parseAddress(
      {
        line1: '',
        suburb: 'a'.repeat(121),
        state: 'XX',
        postcode: '40000',
        unknown: 'x',
        line2: 'flat\u202e2',
      },
      FIVE_FIELDS,
      'address',
    );
    expect(parsed).toEqual({
      ok: false,
      error: [
        { path: 'address.unknown', code: 'unknown' },
        { path: 'address.line1', code: 'required' },
        { path: 'address.line2', code: 'characters' },
        { path: 'address.suburb', code: 'length' },
        { path: 'address.state', code: 'region' },
        { path: 'address.postcode', code: 'length' },
      ],
    });
  });

  it('refuses a postcode outside the pattern and a non-object', () => {
    expect(parseAddress({ ...valid, postcode: '40a0' }, FIVE_FIELDS, 'address')).toEqual({
      ok: false,
      error: [{ path: 'address.postcode', code: 'format' }],
    });
    for (const raw of [null, 'x', [], 42]) {
      expect(parseAddress(raw, FIVE_FIELDS, 'address')).toEqual({
        ok: false,
        error: [{ path: 'address', code: 'format' }],
      });
    }
  });

  it('refuses a value that is not a string and an inherited key', () => {
    expect(parseAddress({ ...valid, suburb: 7 }, FIVE_FIELDS, 'address')).toEqual({
      ok: false,
      error: [{ path: 'address.suburb', code: 'characters' }],
    });
    const withProto = JSON.parse('{"__proto__": {"x": 1}, "line1": "1 St"}') as object;
    const parsed = parseAddress({ ...valid, ...withProto }, FIVE_FIELDS, 'address');
    expect(parsed.ok).toBe(false);
  });

  it('round-trips through its canonical JSON', () => {
    const parsed = parseAddress(valid, FIVE_FIELDS, 'address');
    if (!parsed.ok) throw new Error('valid address refused');
    const json = addressToJson(parsed.value);
    expect(JSON.parse(json)).toEqual({
      line1: '1 George St',
      suburb: 'Brisbane',
      state: 'QLD',
      postcode: '4000',
    });
    expect(addressFromJson(json, FIVE_FIELDS)).toEqual(parsed.value);
  });
});
