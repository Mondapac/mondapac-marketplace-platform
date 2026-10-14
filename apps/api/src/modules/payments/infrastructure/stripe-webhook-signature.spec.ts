import { createHmac } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { isStripeWebhookPath } from '../../../configure-app';
import { SIGNATURE_TOLERANCE_SECONDS, StripeWebhookSignature } from './stripe-webhook-signature';

// Stripe's v1 webhook signature over the exact bytes, per Market secret: every malformed header
// is refused, the comparison passes only with the right secret, body and timestamp.

const NOW = Temporal.Instant.from('2026-10-14T10:00:00Z');
const T = String(NOW.epochMilliseconds / 1000);
const SECRET = 'whsec_spec0secret0au';
const BODY = Buffer.from('{"id":"evt_1"}');
const v1 = (t: string, body: Buffer = BODY, secret = SECRET) =>
  createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');

describe('StripeWebhookSignature', () => {
  const signature = new StripeWebhookSignature({ AU: SECRET }, new FixedClock(NOW));

  it('passes the right secret, body and time, and knows which Markets have a secret', () => {
    expect(signature.verify('AU', BODY, `t=${T},v1=${v1(T)}`)).toBe(true);
    expect(signature.configuredFor('AU')).toBe(true);
    expect(signature.configuredFor('ZZ')).toBe(false);
    expect(signature.configuredFor('toString')).toBe(false);
    expect(signature.verify('ZZ', BODY, `t=${T},v1=${v1(T)}`)).toBe(false);
  });

  it.each([
    ['only a v0 signature', `t=${T},v0=${v1(T)}`],
    ['no timestamp', `v1=${v1(T)}`],
    ['two timestamps', `t=${T},t=${T},v1=${v1(T)}`],
    ['an empty timestamp', `t=,v1=${v1(T)}`],
    ['a short v1', `t=${T},v1=${v1(T).slice(2)}`],
    ['a non-hex v1', `t=${T},v1=${'z'.repeat(64)}`],
    ['an upper-case v1', `t=${T},v1=${v1(T).toUpperCase()}`],
    [
      'more than 8 v1',
      `t=${T},${Array(9)
        .fill(`v1=${v1(T)}`)
        .join(',')}`,
    ],
    ['a part with two =', `t=${T},v1=${v1(T)}=`],
    ['an over-long header', `t=${T},v1=${v1(T)},x=${'a'.repeat(2048)}`],
    ['another secret', `t=${T},v1=${v1(T, BODY, 'whsec_other0secret')}`],
    ['another body', `t=${T},v1=${v1(T, Buffer.from('{"id":"evt_2"}'))}`],
    ['a timestamp changed after signing', `t=${Number(T) + 1},v1=${v1(T)}`],
    ['the same timestamp written with a leading zero', `t=0${T},v1=${v1(T)}`],
    ['a header that is not a string', ['t=1']],
  ])('refuses %s', (_label, header) => {
    expect(signature.verify('AU', BODY, header)).toBe(false);
  });

  it('accepts a timestamp inside the tolerance either way and refuses one outside it', () => {
    for (const offset of [-SIGNATURE_TOLERANCE_SECONDS, SIGNATURE_TOLERANCE_SECONDS]) {
      const t = String(Number(T) + offset);
      expect(signature.verify('AU', BODY, `t=${t},v1=${v1(t)}`)).toBe(true);
    }
    for (const offset of [-SIGNATURE_TOLERANCE_SECONDS - 1, SIGNATURE_TOLERANCE_SECONDS + 1]) {
      const t = String(Number(T) + offset);
      expect(signature.verify('AU', BODY, `t=${t},v1=${v1(t)}`)).toBe(false);
    }
  });

  it('passes when one of several v1 values matches (secret rotation)', () => {
    expect(signature.verify('AU', BODY, `t=${T},v1=${'0'.repeat(64)},v1=${v1(T)}`)).toBe(true);
  });
});

describe('isStripeWebhookPath', () => {
  it.each([
    ['/payments/stripe/webhook/AU', true],
    ['/payments/stripe/webhook/AU?x=1', true],
    ['/payments/stripe/webhook/', true],
    ['/payments/stripe/webhook', false],
    ['/payments/stripe/webhookx/AU', false],
    ['/PAYMENTS/stripe/webhook/AU', false],
    ['/cart/items?next=/payments/stripe/webhook/AU', false],
    [undefined, false],
  ])('%p is %p', (url, expected) => {
    expect(isStripeWebhookPath(url)).toBe(expected);
  });
});
