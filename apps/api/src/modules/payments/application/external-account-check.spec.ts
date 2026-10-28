import { HmacExternalAccountKeyring } from '../infrastructure/hmac-external-account-keyring';
import { TEST_HMAC_KEYS, testKeyring } from '../../../../test/support/payments-fakes';
import { decideHmac, sameHmac } from './external-account-check';

// The keyed hash of the default external account (design 4.6 condition 2, rules i to v): the
// decision over the stored value, the id Stripe shows now and the keys.

const keyring = testKeyring();
const rotated = testKeyring(TEST_HMAC_KEYS, 2);
const ID = 'ba_test_default';
const v1 = keyring.hmac(1, ID)!;
const v2 = rotated.hmac(2, ID)!;

describe('decideHmac', () => {
  it('makes a value that names its key version and holds neither the id nor a key', () => {
    expect(v1).toMatch(/^hmac-sha256:k1:[0-9a-f]{64}$/);
    expect(v2).toMatch(/^hmac-sha256:k2:[0-9a-f]{64}$/);
    expect(v1).not.toContain(ID);
    expect(v1.endsWith(v2.slice(-64))).toBe(false);
    for (const key of Object.values(TEST_HMAC_KEYS)) expect(v1).not.toContain(key);
  });

  it('has nothing to compare when Stripe shows no default external account', () => {
    expect(decideHmac(keyring, v1, null)).toEqual({ kind: 'no-account' });
    expect(decideHmac(keyring, null, null)).toEqual({ kind: 'no-account' });
  });

  it('stamps a never-stamped account with the current key', () => {
    expect(decideHmac(keyring, null, ID)).toEqual({ kind: 'stamp', next: v1 });
    expect(decideHmac(rotated, null, ID)).toEqual({ kind: 'stamp', next: v2 });
  });

  it('does not stamp without a current key (key missing, never a guess)', () => {
    expect(decideHmac(testKeyring(TEST_HMAC_KEYS, null), null, ID)).toEqual({
      kind: 'key-missing',
    });
    expect(decideHmac(testKeyring({}, null), null, ID)).toEqual({ kind: 'key-missing' });
  });

  it('is the same account when the stored value equals the value now under its own key', () => {
    expect(decideHmac(keyring, v1, ID)).toEqual({ kind: 'same', value: v1 });
  });

  it('re-stamps the same account under the current key after a rotation (rule iii), no change', () => {
    expect(decideHmac(rotated, v1, ID)).toEqual({ kind: 'restamp', stored: v1, next: v2 });
  });

  it('is a change when the stored value differs under its own key version', () => {
    expect(decideHmac(keyring, v1, 'ba_test_attacker')).toEqual({
      kind: 'changed',
      stored: v1,
      next: keyring.hmac(1, 'ba_test_attacker'),
    });
    // After a rotation the new value uses the current key.
    expect(decideHmac(rotated, v1, 'ba_test_attacker')).toEqual({
      kind: 'changed',
      stored: v1,
      next: rotated.hmac(2, 'ba_test_attacker'),
    });
  });

  it('never re-stamps a value whose key version is missing (rule iv)', () => {
    const onlyTwo = new HmacExternalAccountKeyring({ 2: TEST_HMAC_KEYS[2] }, 2);
    expect(decideHmac(onlyTwo, v1, ID)).toEqual({ kind: 'key-missing' });
    // Even for an id that would differ: it is not read as a change either.
    expect(decideHmac(onlyTwo, v1, 'ba_test_attacker')).toEqual({ kind: 'key-missing' });
  });

  it('treats a malformed stored value as a missing key, not as a match', () => {
    expect(decideHmac(keyring, 'hmac-sha256:kx:zz', ID)).toEqual({ kind: 'key-missing' });
  });

  it('compares the whole value, and values of unequal length never match', () => {
    expect(sameHmac(v1, v1)).toBe(true);
    expect(sameHmac(v1, `${v1.slice(0, -1)}${v1.endsWith('0') ? '1' : '0'}`)).toBe(false);
    expect(sameHmac(v1, v1.slice(0, -1))).toBe(false);
    expect(sameHmac('', v1)).toBe(false);
  });
});
