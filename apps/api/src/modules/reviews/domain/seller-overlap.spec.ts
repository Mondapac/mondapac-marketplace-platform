import { overlapSignals } from './seller-overlap';

describe('overlap signals', () => {
  it('raises nothing for "no" and for "cannot say"', () => {
    expect(overlapSignals({ sameAddress: null, samePaymentFingerprint: null })).toEqual([]);
    expect(overlapSignals({ sameAddress: false, samePaymentFingerprint: false })).toEqual([]);
  });

  it('raises each signal alone', () => {
    expect(overlapSignals({ sameAddress: true, samePaymentFingerprint: false })).toEqual([
      'same-address-as-seller',
    ]);
    expect(overlapSignals({ sameAddress: null, samePaymentFingerprint: true })).toEqual([
      'same-payment-fingerprint',
    ]);
  });

  it('raises both in a fixed order', () => {
    expect(overlapSignals({ sameAddress: true, samePaymentFingerprint: true })).toEqual([
      'same-address-as-seller',
      'same-payment-fingerprint',
    ]);
  });
});
