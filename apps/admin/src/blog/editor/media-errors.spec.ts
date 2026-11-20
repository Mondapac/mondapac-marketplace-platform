import { describe, expect, it } from 'vitest';
import { mediaProblemOf } from './media-errors.ts';

describe('mediaProblemOf', () => {
  it.each([
    [400, 'validation.failed', 'invalid'],
    [413, 'file.too-large', 'too-large'],
    [415, 'file.unsupported-type', 'unsupported'],
    [422, 'file.too-small', 'too-small'],
    [422, 'file.too-many-pixels', 'too-many-pixels'],
    [422, 'file.unreadable', 'unreadable'],
    [503, 'blog.unavailable', 'busy'],
    [403, 'access.denied', 'denied'],
    [403, 'request.csrf', 'csrf'],
    [429, 'request.throttled', 'throttled'],
    [413, 'request.too-large', 'too-large'],
  ])('maps %s %s to %s', (status, code, key) => {
    expect(mediaProblemOf({ status, code })).toBe(key);
  });

  it('falls back to unavailable for a network failure or a server error, else unknown', () => {
    expect(mediaProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(mediaProblemOf({ status: 500, code: 'whatever' })).toBe('unavailable');
    expect(mediaProblemOf({ status: 404, code: 'whatever' })).toBe('unknown');
    expect(mediaProblemOf({ status: 418, code: 'unknown' })).toBe('unknown');
  });
});
