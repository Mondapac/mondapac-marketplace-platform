import { createHmac, hkdfSync } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { testMarketId } from '../../../../test/support/test-config';
import { HmacPreviewTokens } from './hmac-preview-tokens';

// The internal preview token on both Market fixtures: it verifies only for its Market, before its
// expiry, under the key that signed it, and in its exact format.

const KEY = 'test-only-assistant-preview-key-0123456789';
const AU = testMarketContext(testMarketId('AU'), 'default');
const ZZ = testMarketContext(testMarketId('ZZ'), 'default');
const T0 = Temporal.Instant.from('2026-11-16T01:00:00.750Z');

describe('HmacPreviewTokens', () => {
  const tokens = new HmacPreviewTokens(KEY);

  it.each([
    ['AU', AU, ZZ],
    ['ZZ', ZZ, AU],
  ])('verifies a token of %s for 30 minutes, in that Market only', (_code, market, other) => {
    const issued = tokens.issue(market, T0)!;
    expect(issued.token).toMatch(/^ap1\.\d{10}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt.toString()).toBe('2026-11-16T01:30:00Z');
    expect(tokens.verify(market, issued.token, T0)).toBe(true);
    expect(tokens.verify(market, issued.token, T0.add({ minutes: 29 }))).toBe(true);
    expect(tokens.verify(market, issued.token, issued.expiresAt)).toBe(false);
    expect(tokens.verify(other, issued.token, T0)).toBe(false);
  });

  it('gives each token its own nonce and names no account', () => {
    const a = tokens.issue(AU, T0)!.token;
    const b = tokens.issue(AU, T0)!.token;
    expect(a).not.toBe(b);
    expect(a.split('.')).toHaveLength(4);
  });

  it('refuses a token of another key, a changed part, or a bad shape', () => {
    const issued = tokens.issue(AU, T0)!.token;
    const [version, expiry, nonce, mac] = issued.split('.') as [string, string, string, string];
    expect(new HmacPreviewTokens(`${KEY}x`).verify(AU, issued, T0)).toBe(false);
    const flip = (part: string) => (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    for (const changed of [
      [version, String(Number(expiry) + 60), nonce, mac],
      [version, expiry, flip(nonce), mac],
      [version, expiry, nonce, flip(mac)],
      ['ap2', expiry, nonce, mac],
    ]) {
      expect(tokens.verify(AU, changed.join('.'), T0)).toBe(false);
    }
    for (const bad of [
      undefined,
      null,
      42,
      ['x'],
      '',
      `${issued}.`,
      ` ${issued}`,
      issued + 'A'.repeat(100),
    ]) {
      expect(tokens.verify(AU, bad, T0)).toBe(false);
    }
  });

  it('refuses a correctly signed token whose expiry is further away than the lifetime', () => {
    // Signed as the adapter would, but expiring in two hours: a token the server never issues.
    const key = Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY), new Uint8Array(0), 'assistant.preview-token', 32),
    );
    const expiry = String(Math.floor(T0.epochMilliseconds / 1000) + 2 * 3600);
    const nonce = 'A'.repeat(22);
    const mac = createHmac('sha256', key)
      .update(JSON.stringify(['assistant-internal-preview', 'AU', expiry, nonce]))
      .digest('base64url');
    const token = `ap1.${expiry}.${nonce}.${mac}`;
    expect(tokens.verify(AU, token, T0)).toBe(false);
    expect(tokens.verify(AU, token, T0.add({ minutes: 100 }))).toBe(true);
  });

  it('issues and accepts nothing without a key', () => {
    const off = new HmacPreviewTokens(null);
    expect(off.available()).toBe(false);
    expect(off.issue(AU, T0)).toBeNull();
    expect(off.verify(AU, tokens.issue(AU, T0)!.token, T0)).toBe(false);
    expect(tokens.available()).toBe(true);
  });
});
