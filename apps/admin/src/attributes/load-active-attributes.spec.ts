import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { loadActiveAttributes } from './load-active-attributes.ts';

const call = vi.mocked(callApi);

describe.each([
  { name: 'AU', locale: 'en-AU' },
  { name: 'ZZ', locale: 'ja-JP' },
])('loadActiveAttributes in market $name', ({ locale }) => {
  beforeEach(() => call.mockReset());

  it('follows the cursor with a page size the API accepts', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { items: [{ code: 'a' }], nextAfterId: 'id-1', locales: { default: locale } },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { items: [{ code: 'b' }], nextAfterId: null, locales: { default: locale } },
      } as never);
    const result = await loadActiveAttributes();
    expect(result).toMatchObject({ ok: true, locale });
    expect(result.ok && result.items.map((item) => item.code)).toEqual(['a', 'b']);
    const queries = call.mock.calls.map(([, path]) => new URLSearchParams(path.split('?')[1]));
    expect(queries[0]?.get('limit')).toBe('50');
    expect(queries[0]?.has('afterId')).toBe(false);
    expect(queries[1]?.get('afterId')).toBe('id-1');
  });

  it('fails as a whole when a page fails', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 503, code: 'access.unavailable' },
    } as never);
    expect(await loadActiveAttributes()).toEqual({ ok: false });
  });
});
