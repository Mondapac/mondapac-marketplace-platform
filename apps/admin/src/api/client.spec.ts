import { afterEach, describe, expect, it, vi } from 'vitest';
import { callApi } from './client.ts';

function answer(header: string | null, details?: unknown) {
  const headers = new Headers();
  if (header !== null) headers.set('retry-after', header);
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'throttled', details }), { status: 429, headers }),
      ),
    ),
  );
}

async function waitOf(): Promise<number | undefined> {
  const result = await callApi('GET', 'x');
  if (result.ok) throw new Error('expected a failure');
  return result.failure.details?.retryAfterSeconds;
}

afterEach(() => vi.unstubAllGlobals());

describe('callApi 429 wait', () => {
  it.each([
    ['no header', null, undefined],
    ['an empty header', '', undefined],
    ['zero', '0', undefined],
    ['a negative number', '-5', undefined],
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT', undefined],
    ['an overflowing number', '1e309', undefined],
    ['a number above a day', '86401', undefined],
    ['a valid header', '120', 120],
  ])('reads %s', async (_name, header, expected) => {
    answer(header);
    expect(await waitOf()).toBe(expected);
  });

  it('reads the body alone', async () => {
    answer(null, { retryAfterSeconds: 90 });
    expect(await waitOf()).toBe(90);
  });

  it('prefers a valid body over the header', async () => {
    answer('120', { retryAfterSeconds: 90 });
    expect(await waitOf()).toBe(90);
  });

  it('falls back to the header when the body value is not believable', async () => {
    answer('120', { retryAfterSeconds: 1e9 });
    expect(await waitOf()).toBe(120);
  });

  it('drops a bad body value with no header', async () => {
    answer(null, { retryAfterSeconds: -3 });
    expect(await waitOf()).toBeUndefined();
  });

  it('ignores details that are not a plain object', async () => {
    answer('30', ['x']);
    expect(await waitOf()).toBe(30);
  });
});
