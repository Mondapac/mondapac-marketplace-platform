import { normaliseAddressValue, overlapSignals, sameAddress } from './seller-overlap';

const address = (fields: Record<string, string>) => fields;
const seller = address({ line1: '12 Smith Street', suburb: 'Sunnybank', postcode: '4109' });

describe('same address', () => {
  it('folds case, punctuation and white space', () => {
    expect(normaliseAddressValue('  12,  SMITH   Street. ')).toBe('12 smith street');
    expect(
      sameAddress(
        seller,
        address({ line1: '12 smith street', suburb: 'SUNNYBANK', postcode: '4109' }),
      ),
    ).toBe(true);
  });

  it('is not a match on one shared field (a postcode or a suburb is never enough)', () => {
    expect(sameAddress(seller, address({ postcode: '4109' }))).toBe(false);
    expect(sameAddress(seller, address({ suburb: 'Sunnybank', postcode: '4109' }))).toBe(true);
    expect(sameAddress(seller, address({ line1: 'Other', suburb: 'Sunnybank' }))).toBe(false);
  });

  it('is not a match when a shared field differs, such as another unit', () => {
    expect(
      sameAddress(
        address({ line1: 'Unit 4 12 Smith St', postcode: '4109' }),
        address({ line1: 'Unit 5 12 Smith St', postcode: '4109' }),
      ),
    ).toBe(false);
  });

  it('ignores empty fields and keys only one side has', () => {
    expect(
      sameAddress(
        address({ line1: '12 Smith Street', suburb: '', postcode: '4109', note: 'x' }),
        address({ line1: '12 Smith Street', suburb: 'Sunnybank', postcode: '4109' }),
      ),
    ).toBe(true);
  });
});

describe('overlap signals', () => {
  const none = {
    deliveryAddress: null,
    sellerAddresses: [],
    buyerPaymentFingerprints: [],
    sellerPaymentFingerprints: [],
  };

  it('raises nothing when the source knows nothing', () => {
    expect(overlapSignals(none)).toEqual([]);
  });

  it('raises the address signal against any of the seller addresses', () => {
    expect(
      overlapSignals({
        ...none,
        deliveryAddress: seller,
        sellerAddresses: [address({ line1: 'Registered Office', postcode: '4000' }), seller],
      }),
    ).toEqual(['same-address-as-seller']);
  });

  it('raises the fingerprint signal on a shared fingerprint, ignoring blanks', () => {
    expect(
      overlapSignals({
        ...none,
        buyerPaymentFingerprints: ['', 'fp_a', ' fp_b '],
        sellerPaymentFingerprints: ['fp_b', ' '],
      }),
    ).toEqual(['same-payment-fingerprint']);
    expect(
      overlapSignals({
        ...none,
        buyerPaymentFingerprints: [''],
        sellerPaymentFingerprints: [''],
      }),
    ).toEqual([]);
  });

  it('raises both, in a fixed order, each once', () => {
    expect(
      overlapSignals({
        deliveryAddress: seller,
        sellerAddresses: [seller, seller],
        buyerPaymentFingerprints: ['fp_a', 'fp_a'],
        sellerPaymentFingerprints: ['fp_a'],
      }),
    ).toEqual(['same-address-as-seller', 'same-payment-fingerprint']);
  });
});
