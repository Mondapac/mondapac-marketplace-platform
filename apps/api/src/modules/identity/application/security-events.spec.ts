import type { Id } from '@mondapac/shared-kernel';
import { securityEventOfSignIn, type SignInOutcome } from './security-events';

const ACCOUNT = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const SESSION = '01990000-0000-7000-8000-0000000000b1' as Id<'Session'>;
const ADDRESS = '203.0.113.7';

const outcome = (code: string, overrides: Partial<SignInOutcome> = {}): SignInOutcome => ({
  population: 'seller',
  accountId: ACCOUNT,
  outcome: code,
  sessionId: null,
  address: ADDRESS,
  ...overrides,
});

describe('the security event of a sign-in record (SOC package 1)', () => {
  it('maps a session, the refusals and the password and factor outcomes', () => {
    const typeOf = (code: string, overrides?: Partial<SignInOutcome>) =>
      securityEventOfSignIn(outcome(code, overrides))?.type ?? null;

    expect(typeOf('signed-in', { sessionId: SESSION })).toBe('identity.sign-in.succeeded');
    expect(typeOf('credentials.invalid')).toBe('identity.sign-in.failed');
    expect(typeOf('link.rejected')).toBe('identity.sign-in.failed');
    expect(typeOf('challenge.rejected')).toBe('identity.sign-in.failed');
    expect(typeOf('account.disabled')).toBe('identity.sign-in.failed');
    expect(typeOf('request.throttled')).toBe('identity.sign-in.throttled');
    expect(typeOf('second-factor.invalid')).toBe('identity.second-factor.failed');
    expect(typeOf('second-factor.locked')).toBe('identity.second-factor.locked');
    expect(typeOf('password.current-incorrect')).toBe('identity.password.confirm-failed');
    expect(typeOf('password-changed')).toBe('identity.password.changed');
    expect(typeOf('password-reset')).toBe('identity.password.reset');
  });

  it('makes no event of a step towards a session or of the account state alone', () => {
    for (const code of [
      'challenge-issued',
      'second-factor-enrolment-started',
      'email-verification-required',
      'membership.none',
      'request.busy',
      'provider.link-required',
      'constructor',
      'toString',
    ]) {
      expect(securityEventOfSignIn(outcome(code))).toBeNull();
    }
    // A session without its id, and an account event without its account, are not recorded.
    expect(securityEventOfSignIn(outcome('signed-in'))).toBeNull();
    expect(securityEventOfSignIn(outcome('password-reset', { accountId: null }))).toBeNull();
  });

  it('keeps the address, the account and codes only', () => {
    expect(securityEventOfSignIn(outcome('credentials.invalid', { accountId: null }))).toEqual({
      type: 'identity.sign-in.failed',
      targetId: null,
      ip: ADDRESS,
      payload: { population: 'seller', reason: 'credentials-invalid' },
    });
    expect(
      securityEventOfSignIn(outcome('signed-in', { population: 'admin', sessionId: SESSION })),
    ).toEqual({
      type: 'identity.sign-in.succeeded',
      targetId: ACCOUNT,
      ip: ADDRESS,
      payload: { population: 'admin', sessionId: SESSION },
    });
  });
});
