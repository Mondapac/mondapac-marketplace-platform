import { describe, expect, it } from 'vitest';
import type { ApiFailure } from '../api/client.ts';
import { fieldErrorKeys, formErrorKey, passwordRuleKey } from './messages-for-errors.ts';

const failure = (code: string, details?: ApiFailure['details']): ApiFailure => ({
  status: 400,
  code,
  ...(details === undefined ? {} : { details }),
});

describe('formErrorKey', () => {
  it('rounds the throttle wait up to whole minutes, at least one, 60 s by default', () => {
    expect(formErrorKey(failure('request.throttled', { retryAfterSeconds: 61 }))).toEqual({
      key: 'request.throttled',
      values: { minutes: 2 },
    });
    expect(formErrorKey(failure('request.throttled', { retryAfterSeconds: 1 }))?.values).toEqual({
      minutes: 1,
    });
    expect(formErrorKey(failure('request.throttled'))?.values).toEqual({ minutes: 1 });
  });

  it.each([
    ['credentials.invalid', 'credentials.invalid'],
    ['account.disabled', 'account.disabled.seller'],
    ['membership.none', 'membership.none'],
    ['seller-access.suspended', 'seller-access.suspended'],
    ['request.csrf', 'request.csrf'],
    ['second-factor-required', 'second-factor.unsupported'],
    ['network', 'network'],
    ['something.else', 'unknown'],
  ])('maps %s to %s', (code, key) => {
    expect(formErrorKey(failure(code))?.key).toBe(key);
  });
});

describe('fieldErrorKeys', () => {
  it('maps fields to message keys and keeps only requested fields', () => {
    const result = fieldErrorKeys(
      failure('validation.failed', {
        fields: [
          { path: 'email', code: 'required' },
          { path: 'displayName', code: 'characters' },
          { path: 'password', code: 'required' },
          { path: 'other', code: 'x' },
        ],
      }),
      ['email', 'name', 'password'],
    );
    expect(result).toEqual({
      email: 'validation.email.required',
      name: 'validation.name.characters',
      password: 'validation.password.required',
    });
  });

  it('uses the format message for any other email problem', () => {
    expect(
      fieldErrorKeys(
        failure('validation.failed', { fields: [{ path: 'email', code: 'format' }] }),
        ['email'],
      ),
    ).toEqual({ email: 'validation.email.format' });
  });
});

describe('passwordRuleKey', () => {
  it.each([
    ['common', 'password.rejected.common'],
    ['contains-identity', 'password.rejected.contains-identity'],
    ['length', 'password.rejected.length'],
    ['unknown-rule', 'password.rejected.length'],
  ])('rule %s gives %s', (rule, key) => {
    expect(passwordRuleKey(failure('password.rejected', { rule }))).toBe(key);
  });
});
