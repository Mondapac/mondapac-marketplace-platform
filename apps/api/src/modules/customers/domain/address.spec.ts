import { addressFromJson, addressToJson, parseAddress, type AddressFormat } from './address';

// The address rules on a format with regions (like AU) and one without, plus the sealed shape.

const WITH_REGIONS: AddressFormat = {
  countryCode: 'AU',
  postcodePattern: '^[0-9]{4}$',
  regions: ['NSW', 'QLD'],
};
const WITHOUT_REGIONS: AddressFormat = {
  countryCode: 'ZZ',
  postcodePattern: '^[0-9]{7}$',
  regions: [],
};
const valid = {
  recipientFirstName: '  Aisha ',
  recipientLastName: 'Rahman',
  phone: '(04) 1234-5678',
  line1: '12 Example Street',
  line2: '',
  suburb: 'Sunnybank',
  region: 'qld',
  postcode: '4109',
  deliveryNotes: null,
};

describe('parseAddress', () => {
  it('trims, normalises the phone, matches the region in any case and leaves blanks out', () => {
    const parsed = parseAddress(valid, WITH_REGIONS);
    expect(parsed).toEqual({
      ok: true,
      value: {
        recipientFirstName: 'Aisha',
        recipientLastName: 'Rahman',
        phone: '0412345678',
        line1: '12 Example Street',
        line2: null,
        suburb: 'Sunnybank',
        region: 'QLD',
        postcode: '4109',
        deliveryNotes: null,
      },
    });
  });

  it('names every refused field by path and code, never by value', () => {
    const parsed = parseAddress(
      {
        recipientFirstName: '',
        recipientLastName: 'x'.repeat(61),
        phone: 'call me',
        line1: 'line\nbreak',
        suburb: 7,
        region: 'VIC',
        postcode: '41090',
        deliveryNotes: '​',
      },
      WITH_REGIONS,
    );
    expect(parsed).toEqual({
      ok: false,
      error: [
        { path: 'recipientFirstName', code: 'required' },
        { path: 'recipientLastName', code: 'length' },
        { path: 'phone', code: 'format' },
        { path: 'line1', code: 'characters' },
        { path: 'suburb', code: 'type' },
        { path: 'region', code: 'region' },
        { path: 'postcode', code: 'format' },
        { path: 'deliveryNotes', code: 'characters' },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('call me');
  });

  it('requires a region only where the Market has regions, and refuses one where it has none', () => {
    expect(parseAddress({ ...valid, region: null }, WITH_REGIONS)).toMatchObject({
      ok: false,
      error: [{ path: 'region', code: 'required' }],
    });
    const zz = { ...valid, postcode: '1000001' };
    expect(parseAddress({ ...zz, region: undefined }, WITHOUT_REGIONS)).toMatchObject({
      ok: true,
      value: { region: null, postcode: '1000001' },
    });
    expect(parseAddress(zz, WITHOUT_REGIONS)).toMatchObject({
      ok: false,
      error: [{ path: 'region', code: 'region' }],
    });
  });

  it('refuses a body that is not an object', () => {
    expect(parseAddress([valid], WITH_REGIONS)).toEqual({
      ok: false,
      error: [{ path: '', code: 'type' }],
    });
  });
});

describe('the sealed shape', () => {
  it('reads back what it wrote, and refuses a damaged shape', () => {
    const parsed = parseAddress(valid, WITH_REGIONS);
    if (!parsed.ok) throw new Error('fixture');
    expect(addressFromJson(addressToJson(parsed.value))).toEqual(parsed.value);
    expect(() => addressFromJson('{"line1":1}')).toThrow('customers.stored-address-invalid');
    expect(() => addressFromJson('[]')).toThrow('customers.stored-address-invalid');
  });
});
