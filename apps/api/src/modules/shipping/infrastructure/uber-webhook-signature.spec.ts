import { createHmac } from 'node:crypto';
import { UberWebhookSignature } from './uber-webhook-signature';

const SECRET = 'uber-test-webhook-secret-0123456789abc';
const body = new TextEncoder().encode('{"kind":"event.delivery_status","id":"evt_1"}');
const hmac = (bytes: Uint8Array, secret = SECRET) =>
  createHmac('sha256', secret).update(bytes).digest('hex');

describe('UberWebhookSignature', () => {
  const check = new UberWebhookSignature({ AU: SECRET });

  it('accepts the hex HMAC-SHA256 of the exact raw bytes under the Market secret', () => {
    expect(check.verify('AU', body, hmac(body))).toBe(true);
    expect(check.verify('AU', body, ` ${hmac(body).toUpperCase()} `)).toBe(true);
  });

  it('refuses a changed byte, another secret, another Market and a Market without a secret', () => {
    const changed = new TextEncoder().encode('{"kind":"event.delivery_status","id":"evt_2"}');
    expect(check.verify('AU', changed, hmac(body))).toBe(false);
    expect(check.verify('AU', body, hmac(body, 'another-secret-0123456789abcdefgh'))).toBe(false);
    expect(check.verify('ZZ', body, hmac(body))).toBe(false);
    expect(check.configuredFor('AU')).toBe(true);
    expect(check.configuredFor('ZZ')).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 12],
    ['an array', [hmac(body)]],
    ['empty', ''],
    ['not hex', 'z'.repeat(64)],
    ['short', hmac(body).slice(2)],
    ['long', hmac(body) + '00'],
    ['prefixed', `sha256=${hmac(body)}`],
    ['oversized', 'a'.repeat(5000)],
  ])('refuses a signature header that is %s', (_name, value) => {
    expect(check.verify('AU', body, value)).toBe(false);
  });

  it('does not treat an inherited property name as a Market', () => {
    expect(check.configuredFor('constructor')).toBe(false);
    expect(check.verify('__proto__', body, hmac(body))).toBe(false);
  });
});
