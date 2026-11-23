import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// /session-ended clears the rejected cookie and sends the browser to sign-in with the notice,
// carrying a safe ?next= along. The API answer is a double.

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('./config.ts', () => ({ panelConfig: () => ({ apiBaseUrl: 'http://api.test' }) }));
vi.mock('./bff.ts', () => ({
  panelHostFor: () => ({ origin: 'http://admin.localhost:3002', marketId: 'AU' }),
  upstreamHeaders: (request: Request) => new Headers(request.headers),
}));

import { GET } from '../../app/session-ended/route.ts';

const visit = (query: string) =>
  GET(new Request(`http://admin.localhost:3002/session-ended${query}`));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(
    new Response(null, { status: 401, headers: { 'set-cookie': 'sid=; Max-Age=0' } }),
  );
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('/session-ended', () => {
  it('passes the page asked for on to sign-in with the notice', async () => {
    const response = await visit('?next=%2Forders%3Fview%3Dlate');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://admin.localhost:3002/sign-in?notice=session-ended&next=%2Forders%3Fview%3Dlate',
    );
    expect(response.headers.get('set-cookie')).toContain('sid=');
  });

  it.each(['%2F%2Fevil.example', '%2F.%2F%2Fevil.example', 'https%3A%2F%2Fevil.example'])(
    'drops a next that could leave the panel: %s',
    async (next) => {
      const response = await visit(`?next=${next}`);
      expect(response.headers.get('location')).toBe(
        'http://admin.localhost:3002/sign-in?notice=session-ended',
      );
    },
  );

  it('opens the page asked for when the session turns out to be fine', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const response = await visit('?next=%2Forders');
    expect(response.headers.get('location')).toBe('http://admin.localhost:3002/orders');
  });
});
