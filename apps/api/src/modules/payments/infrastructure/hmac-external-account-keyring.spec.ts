import { createHmac } from 'node:crypto';
import { HmacExternalAccountKeyring } from './hmac-external-account-keyring';

const KEYS = { 1: 'a'.repeat(40), 2: 'b'.repeat(40) };

describe('HmacExternalAccountKeyring', () => {
  it('makes HMAC-SHA256 of the purpose and the id, named by the key version', () => {
    const keyring = new HmacExternalAccountKeyring(KEYS, 2);
    const expected = createHmac('sha256', KEYS[1])
      .update('payments.external-account\0')
      .update('ba_1')
      .digest('hex');
    expect(keyring.hmac(1, 'ba_1')).toBe(`hmac-sha256:k1:${expected}`);
    expect(keyring.hmac(2, 'ba_1')).not.toBe(keyring.hmac(1, 'ba_1'));
  });

  it('answers null for a version without a key, never a value of another key', () => {
    const keyring = new HmacExternalAccountKeyring(KEYS, 2);
    expect(keyring.hmac(3, 'ba_1')).toBeNull();
  });

  it('has a current version only when its key is set', () => {
    expect(new HmacExternalAccountKeyring(KEYS, 2).currentVersion()).toBe(2);
    expect(new HmacExternalAccountKeyring(KEYS, null).currentVersion()).toBeNull();
    expect(new HmacExternalAccountKeyring({ 1: KEYS[1] }, 2).currentVersion()).toBeNull();
    expect(new HmacExternalAccountKeyring({}, null).currentVersion()).toBeNull();
  });
});
