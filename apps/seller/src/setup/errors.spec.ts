import { describe, expect, it } from 'vitest';
import { problemOf } from './errors.ts';

describe('problemOf', () => {
  it('maps validation problems to one message per field, first problem wins', () => {
    const problem = problemOf({
      status: 400,
      code: 'validation.failed',
      details: {
        fields: [
          { path: 'storeName', code: 'required' },
          { path: 'storeName', code: 'length' },
          { path: 'address.postcode', code: 'unknown-field' },
        ],
      },
    });
    expect(problem.form?.key).toBe('sellers.validation.summary');
    expect(problem.fields).toEqual({
      storeName: 'sellers.validation.required',
      'address.postcode': 'sellers.validation.invalid',
    });
  });

  it.each([
    ['phone.required', 'phone', 'sellers.error.phone.required'],
    ['identifier.checksum', 'identifier', 'sellers.error.identifier.checksum'],
    ['slug.taken', 'slug', 'sellers.error.slug.taken'],
    ['slug.format', 'slug', 'sellers.error.slug.format'],
  ])('puts %s on the %s field', (code, field, key) => {
    expect(problemOf({ status: 422, code }).fields).toEqual({ [field]: key });
  });

  it('gives a problem on a path no input owns a form message', () => {
    const problem = problemOf({
      status: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'address', code: 'format' }] },
    });
    expect(problem.form?.key).toBe('sellers.validation.summary');
  });

  it('puts a time zone that cannot be selected on the zone field, and 503 on its own message', () => {
    expect(problemOf({ status: 409, code: 'timezone.not-selectable' }).fields).toEqual({
      timezone: 'sellers.error.timezone.not-selectable',
    });
    expect(problemOf({ status: 503, code: 'sellers.unavailable' }).form?.key).toBe(
      'sellers.error.unavailable',
    );
  });

  it('shows known top-level codes as a form message and everything else as unknown', () => {
    expect(problemOf({ status: 429, code: 'lookup.limit' }).form?.key).toBe(
      'sellers.error.lookup.limit',
    );
    expect(problemOf({ status: 403, code: 'request.csrf' }).form?.key).toBe(
      'identity.error.request.csrf',
    );
    expect(problemOf({ status: 500, code: 'weird' }).form?.key).toBe('identity.error.unknown');
    expect(problemOf({ status: 0, code: 'network' }).form?.key).toBe('identity.error.unknown');
  });
});
