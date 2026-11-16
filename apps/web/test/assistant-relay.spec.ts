import { describe, expect, it, vi } from 'vitest';
import { parseStorefrontApiConfig, type StorefrontApiConfig } from '../src/storefront/config.ts';
import {
  assistantQuery,
  isSessionPathAllowed,
  relaySession,
  upstreamCookie,
  type RelayLog,
} from '../src/storefront/session-relay.ts';

const CONFIG = parseStorefrontApiConfig({
  API_BASE_URL: 'http://localhost:3000',
  STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU',
  BFF_CLIENT_ADDRESS_KEY_ID: 'storefront',
  BFF_CLIENT_ADDRESS_SECRET: Buffer.alloc(32, 7).toString('base64'),
}) as StorefrontApiConfig;
const ORIGIN = 'http://storefront.localhost:3003';
const CONVERSATION = '0192f000-0000-7000-8000-000000000001';
const TOKEN = 'ap1.1893456000.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const COOKIES = [
  '__Host-session-customer-AU=sess',
  '__Host-cart-guest-AU=cart',
  '__Host-assistant-guest-AU=guest',
  'other=1',
].join('; ');
const silent: RelayLog = () => undefined;

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  answer: () => Response = () => Response.json({ ok: true }),
) {
  const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(answer()),
  );
  const request = new Request(`${ORIGIN}/api/${path}`, {
    method,
    headers: {
      host: 'storefront.localhost:3003',
      'x-mp-client-address': '203.0.113.9',
      cookie: COOKIES,
      ...(method === 'GET'
        ? {}
        : { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }),
      ...headers,
    },
    ...(method === 'GET' ? {} : { body: '{"text":"hi"}' }),
  });
  const parts = path.split('?')[0]!.split('/');
  return {
    upstream,
    run: () => relaySession(CONFIG, request, parts, upstream as unknown as typeof fetch, silent),
    sent: () => {
      const [url, init] = upstream.mock.calls[0]!;
      return { url, headers: new Headers(init.headers) };
    },
  };
}

describe('assistant routes of the buyer relay', () => {
  it('allows the storefront read and a message to one conversation, nothing else under assistant', () => {
    expect(isSessionPathAllowed('GET', ['assistant', 'storefront'])).toBe(true);
    expect(
      isSessionPathAllowed('POST', ['assistant', 'conversations', CONVERSATION, 'messages']),
    ).toBe(true);
    for (const [method, path] of [
      ['POST', ['assistant', 'storefront']],
      ['GET', ['assistant', 'conversations', CONVERSATION, 'messages']],
      ['GET', ['assistant', 'conversations']],
      ['GET', ['assistant', 'conversations', CONVERSATION]],
      ['DELETE', ['assistant', 'conversations', CONVERSATION]],
      ['POST', ['assistant', 'conversations', 'x-not-a-uuid', 'messages']],
      ['POST', ['assistant', 'conversations', `${CONVERSATION}/..`, 'messages']],
      ['POST', ['assistant', 'conversations', CONVERSATION, 'messages', 'extra']],
      ['GET', ['assistant', 'admin', 'settings']],
      ['POST', ['assistant', 'admin', 'preview-token']],
      ['GET', ['assistant', 'storefront', 'x']],
    ] as const) {
      expect(isSessionPathAllowed(method, path), `${method} ${path.join('/')}`).toBe(false);
    }
  });

  it('refuses an assistant path that is not listed with a 404 and never calls the API', async () => {
    const c = call('GET', 'assistant/admin/settings');
    expect((await c.run()).status).toBe(404);
    expect(c.upstream).not.toHaveBeenCalled();
  });

  it('passes the guest cookie, the session and the preview header only on assistant paths', async () => {
    const a = call('GET', 'assistant/storefront', { 'x-assistant-preview': TOKEN });
    await a.run();
    const cookie = a.sent().headers.get('cookie');
    expect(cookie).toBe('__Host-session-customer-AU=sess; __Host-assistant-guest-AU=guest');
    expect(a.sent().headers.get('x-assistant-preview')).toBe(TOKEN);

    // Another path: the guest cookie and the preview header never cross.
    const cart = call('GET', 'cart', { 'x-assistant-preview': TOKEN });
    await cart.run();
    expect(cart.sent().headers.get('cookie')).toBe(
      '__Host-session-customer-AU=sess; __Host-cart-guest-AU=cart',
    );
    expect(cart.sent().headers.has('x-assistant-preview')).toBe(false);
    expect(upstreamCookie(COOKIES, 'AU')).not.toContain('assistant-guest');
  });

  it('drops a preview header that is not shaped like a token', async () => {
    for (const bad of ['short', `${TOKEN}!`, 'a'.repeat(301), 'x y'.repeat(10)]) {
      const c = call('GET', 'assistant/storefront', { 'x-assistant-preview': bad });
      await c.run();
      expect(c.sent().headers.has('x-assistant-preview')).toBe(false);
    }
  });

  it('passes only a well-shaped visitor and lang as the query of the storefront read', async () => {
    const c = call('GET', 'assistant/storefront?visitor=0123456789abcdef&lang=en-AU&evil=1&x[]=2');
    await c.run();
    expect(c.sent().url).toBe(
      'http://localhost:3000/assistant/storefront?visitor=0123456789abcdef&lang=en-AU',
    );
    expect(assistantQuery('http://h/api/x?visitor=short&lang=%3Cscript%3E')).toBe('');
    expect(assistantQuery('http://h/api/x')).toBe('');
    // Other paths get no query at all.
    const cart = call('GET', 'cart?visitor=0123456789abcdef');
    await cart.run();
    expect(cart.sent().url).toBe('http://localhost:3000/cart');
  });

  it('lets only the assistant guest cookie and the session come back from an assistant answer', async () => {
    const answer = () => {
      const headers = new Headers({ 'content-type': 'text/event-stream; charset=utf-8' });
      headers.append(
        'set-cookie',
        '__Host-assistant-guest-AU=t; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax',
      );
      headers.append('set-cookie', '__Host-cart-guest-AU=evil; Path=/; Secure');
      headers.append('set-cookie', 'other=1');
      headers.set('retry-after', '12');
      return new Response('event: done\ndata: {}\n\n', { status: 200, headers });
    };
    const c = call('POST', `assistant/conversations/${CONVERSATION}/messages`, {}, answer);
    const response = await c.run();
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-assistant-guest-AU=t; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax',
    ]);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('retry-after')).toBe('12');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('event: done\ndata: {}\n\n');
  });

  it('keeps the same-origin rule for the message POST and does not log the conversation id or token', async () => {
    const lines: Record<string, string | number>[] = [];
    const cross = call('POST', `assistant/conversations/${CONVERSATION}/messages`, {
      'sec-fetch-site': 'cross-site',
      'x-assistant-preview': TOKEN,
    });
    expect((await cross.run()).status).toBe(403);
    expect(cross.upstream).not.toHaveBeenCalled();
    const request = new Request(`${ORIGIN}/api/x`, {
      method: 'POST',
      headers: {
        host: 'storefront.localhost:3003',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-assistant-preview': TOKEN,
        'x-mp-client-address': '203.0.113.9',
      },
      body: '{"text":"hi"}',
    });
    await relaySession(
      CONFIG,
      request,
      ['assistant', 'conversations', CONVERSATION, 'messages'],
      () => Promise.resolve(new Response('{}', { status: 503 })),
      (line) => lines.push(line),
    );
    const logged = JSON.stringify(lines);
    expect(logged).toContain('assistant/conversations/:id/messages');
    expect(logged).not.toContain(CONVERSATION);
    expect(logged).not.toContain(TOKEN);
  });

  it('waits for a model answer longer than the 5 s of the other routes', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await call('POST', `assistant/conversations/${CONVERSATION}/messages`).run();
    await call('GET', 'cart').run();
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([30_000, 5000]);
    spy.mockRestore();
  });
  it('answers 404 to a segment that smuggles a slash, backslash, encoding or dot-segment', async () => {
    for (const parts of [
      ['assistant/storefront'],
      ['assistant\\storefront'],
      ['assistant', '%2Fstorefront'],
      ['assistant', 'storefront%2F'],
      ['assistant', '..'],
      ['assistant', '.', 'storefront'],
      ['assistant', ''],
      ['cart/merge'],
      ['cart%2Fmerge'],
    ]) {
      const upstream = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
      const request = new Request(`${ORIGIN}/api/x`, {
        headers: { host: 'storefront.localhost:3003', 'x-mp-client-address': '203.0.113.9' },
      });
      const answer = await relaySession(CONFIG, request, parts, upstream, silent);
      expect(answer.status, parts.join('|')).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    }
  });

  it('answers a clean 503 when the answer body aborts while it is read, and logs it', async () => {
    const lines: Record<string, string | number>[] = [];
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new DOMException('aborted', 'AbortError')),
    });
    const request = new Request(`${ORIGIN}/api/assistant/storefront?visitor=v&lang=en`, {
      headers: { host: 'storefront.localhost:3003', 'x-mp-client-address': '203.0.113.9' },
    });
    const answer = await relaySession(
      CONFIG,
      request,
      ['assistant', 'storefront'],
      () => Promise.resolve(new Response(stream, { status: 200 })),
      (line) => lines.push(line),
    );
    expect(answer.status).toBe(503);
    expect(lines.map((l) => l.msg)).toContain('storefront.session.upstream-unreachable');
  });

  it('refuses an answer over the cap: 256 KB for the assistant, 1 MB elsewhere', async () => {
    const big = (bytes: number) => () => new Response(new Uint8Array(bytes), { status: 200 });
    const assistant = call(
      'GET',
      'assistant/storefront?visitor=v&lang=en',
      {},
      big(256 * 1024 + 1),
    );
    expect((await assistant.run()).status).toBe(502);
    const fits = call('GET', 'assistant/storefront?visitor=v&lang=en', {}, big(256 * 1024));
    expect((await fits.run()).status).toBe(200);
    const other = call('GET', 'cart', {}, big(256 * 1024 + 1));
    expect((await other.run()).status).toBe(200);
    const huge = call('GET', 'cart', {}, big(1024 * 1024 + 1));
    expect((await huge.run()).status).toBe(502);
  });
});
