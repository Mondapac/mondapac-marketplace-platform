import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The deadline of a server read: a hung API answers unavailable instead of holding the page.

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'seller.localhost:3001', cookie: 'sid=1' })),
}));
vi.mock('./config.ts', () => ({ panelConfig: () => ({ apiBaseUrl: 'http://api.test' }) }));
vi.mock('./bff.ts', () => ({
  panelHostFor: () => ({ origin: 'http://seller.localhost:3001', marketId: 'AU' }),
  upstreamHeaders: (request: Request) => new Headers(request.headers),
}));

import { serverGet } from './server-fetch.ts';

describe('serverGet', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the body of an answer', async () => {
    await expect(serverGet('x')).resolves.toEqual({ kind: 'ok', body: { ok: 1 } });
  });

  it('sets no deadline unless one is asked for', async () => {
    await serverGet('x');
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeUndefined();
  });

  it('answers unavailable when the API does not answer within the deadline', async () => {
    // A fetch that only ends when its signal aborts, as a hung API would.
    mocks.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(serverGet('identity/x/session', { timeoutMs: 20 })).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ msg: 'panel.server-get.timeout', path: 'identity/x/session' }),
    );
    log.mockRestore();
  });
});
