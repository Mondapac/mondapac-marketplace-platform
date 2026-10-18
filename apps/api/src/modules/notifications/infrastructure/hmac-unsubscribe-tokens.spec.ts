import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  HmacUnsubscribeTokens,
  LocalNotificationsSecretRefusedError,
  localNotificationsSecret,
} from './hmac-unsubscribe-tokens';

const id = (n: number): Id<'Account'> => {
  const parsed = parseId<'Account'>(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const ACCOUNT = id(0xa1);

describe('HmacUnsubscribeTokens (personalization 1b)', () => {
  const tokens = new HmacUnsubscribeTokens(new Uint8Array(32).fill(7));

  it('issues a URL-safe token that verifies to its account in its Market only', () => {
    const token = tokens.issue(AU, ACCOUNT);
    expect(token).toMatch(/^u1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(encodeURIComponent(token)).toBe(token);
    expect(tokens.verify(AU, token)).toBe(ACCOUNT);
    expect(tokens.verify(ZZ, token)).toBeNull();
  });

  it('refuses a forged, swapped, malformed or foreign-key token', () => {
    const token = tokens.issue(AU, ACCOUNT);
    const [, , mac] = token.split('.');
    const other = new HmacUnsubscribeTokens(new Uint8Array(32).fill(8));
    for (const bad of [
      `u1.${id(0xb2)}.${mac}`,
      `u2.${ACCOUNT}.${mac}`,
      `${token}x`,
      token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
      other.issue(AU, ACCOUNT),
      '',
      'u1..',
      'x'.repeat(500),
      undefined,
      ['u1'],
      42,
    ]) {
      expect(tokens.verify(AU, bad)).toBeNull();
    }
  });

  it('refuses a secret that is not 32 bytes', () => {
    expect(() => new HmacUnsubscribeTokens(new Uint8Array(16))).toThrow(TypeError);
  });

  it('starts its stand-in secret only in an explicit development or test environment', () => {
    expect(localNotificationsSecret({ nodeEnv: 'test', nodeEnvExplicit: true })).toHaveLength(32);
    for (const environment of [
      { nodeEnv: 'production', nodeEnvExplicit: true },
      { nodeEnv: 'test', nodeEnvExplicit: false },
    ] as const) {
      expect(() => localNotificationsSecret(environment as never)).toThrow(
        LocalNotificationsSecretRefusedError,
      );
    }
  });
});
