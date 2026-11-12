import { describe, expect, it, vi } from 'vitest';
import { relay, upstreamHeaders } from './bff.ts';
import type { PanelConfig } from './config.ts';

const config: PanelConfig = {
  apiBaseUrl: 'http://api.test',
  hosts: [
    { origin: 'http://seller.localhost:3001', host: 'seller.localhost:3001', marketId: 'AU' },
  ],
  passwordMinLength: 15,
  passwordMaxLength: 128,
  marketName: 'Australia',
  locale: 'en-AU',
  supportEmail: 'support@example.com',
  storefrontAddress: null,
  clientAddressKey: null,
};

const sameOrigin = {
  host: 'seller.localhost:3001',
  origin: 'http://seller.localhost:3001',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};

function post(path: string, headers: Record<string, string> = sameOrigin, body = '{}') {
  return new Request(`http://seller.localhost:3001/api/${path}`, { method: 'POST', headers, body });
}

const upstreamOk = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"code":"signed-in"}', { status: 200 })));

describe('relay second-factor paths', () => {
  it.each([
    'identity/seller/sign-in/second-factor',
    'identity/seller/second-factor/enrolment',
    'identity/seller/second-factor/enrolment/confirm',
    'identity/seller/second-factor/remove',
    'identity/seller/second-factor/recovery-codes',
    'identity/seller/second-factor/reset/confirm',
    'identity/seller/step-up/verify',
  ])('forwards POST %s', async (path) => {
    const upstream = upstreamOk();
    const response = await relay(config, post(path), path.split('/'), upstream);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('refuses other second-factor shapes', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      post('identity/seller/second-factor/other'),
      ['identity', 'seller', 'second-factor', 'other'],
      upstream,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay logging', () => {
  it('logs the status and the API correlation id for an error answer, and nothing secret', async () => {
    const log = vi.fn();
    const upstream = new Response('{"code":"credentials.invalid"}', {
      status: 401,
      headers: { 'x-correlation-id': 'abc-123' },
    });
    await relay(
      config,
      post(
        'identity/seller/sign-in',
        { ...sameOrigin, cookie: 'secret=1' },
        '{"password":"hunter2"}',
      ),
      ['identity', 'seller', 'sign-in'],
      () => Promise.resolve(upstream),
      log,
    );
    expect(log).toHaveBeenCalledWith({
      msg: 'panel.relay.error-answer',
      method: 'POST',
      path: 'identity/seller/sign-in',
      status: 401,
      marketId: 'AU',
      correlationId: 'abc-123',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret=1');
  });

  it('logs an unreachable API and stays quiet on success', async () => {
    const log = vi.fn();
    await relay(
      config,
      post('identity/seller/sign-in'),
      ['identity', 'seller', 'sign-in'],
      () => Promise.reject(new Error('down')),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'panel.relay.upstream-unreachable' }),
    );
    const quiet = vi.fn();
    await relay(
      config,
      post('identity/seller/sign-in'),
      ['identity', 'seller', 'sign-in'],
      () => Promise.resolve(new Response('{}', { status: 200 })),
      quiet,
    );
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe('relay allowlist for the seller file', () => {
  const put = (path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method: 'PUT',
      headers: sameOrigin,
      body: '{}',
    });

  it('relays the POSTs of submit and withdraw, same-origin only, and nothing near them', async () => {
    const post = (path: string, headers: Record<string, string> = sameOrigin) =>
      new Request(`http://seller.localhost:3001/api/${path}`, {
        method: 'POST',
        headers,
        body: '{}',
      });
    for (const name of ['submit', 'withdraw']) {
      const upstream = upstreamOk();
      const path = ['sellers', 'my-file', name];
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
      const blocked = upstreamOk();
      const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
      const refused = await relay(config, post(path.join('/'), crossSite), path, blocked);
      expect(refused.status).toBe(403);
      expect(blocked).not.toHaveBeenCalled();
    }
    for (const path of [
      ['sellers', 'my-file', 'submit', 'extra'],
      ['sellers', 'my-file', 'approve'],
    ]) {
      const upstream = upstreamOk();
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    }
  });

  it('relays the setup PUTs and refuses a PUT elsewhere', async () => {
    const upstream = upstreamOk();
    const ok = await relay(
      config,
      put('sellers/my-file/slug'),
      ['sellers', 'my-file', 'slug'],
      upstream,
    );
    expect(ok.status).toBe(200);
    const no = await relay(
      config,
      put('sellers/my-file/submit'),
      ['sellers', 'my-file', 'submit'],
      upstream,
    );
    expect(no.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('relay allowlist for the own profile', () => {
  const send = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
    relay(
      config,
      new Request(`http://seller.localhost:3001/api/${path}`, { method, headers, body: '{}' }),
      path.split('/'),
      upstreamOk(),
    );

  it('relays the display name write on its exact path and method, same-origin only', async () => {
    const path = 'identity/seller/profile/display-name';
    expect((await send('PUT', path)).status).toBe(200);
    expect((await send('POST', path)).status).toBe(404);
    expect((await send('PUT', `${path}/extra`)).status).toBe(404);
    const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
    expect((await send('PUT', path, crossSite)).status).toBe(403);
  });

  it('relays the password change by POST only', async () => {
    const path = 'identity/seller/change-password';
    expect((await send('POST', path)).status).toBe(200);
    expect((await send('PUT', path)).status).toBe(404);
  });
});

describe('relay', () => {
  it('answers 404 for a host that is not listed', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/seller/sign-in', { ...sameOrigin, host: 'evil.test' }),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 404 for a path outside the allowlist', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an unsafe request that is not same-origin', async () => {
    const fetchImpl = upstreamOk();
    const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
    expect(
      (
        await relay(
          config,
          post('identity/seller/sign-in', crossSite),
          ['identity', 'seller', 'sign-in'],
          fetchImpl,
        )
      ).status,
    ).toBe(403);
    const otherOrigin = { ...sameOrigin, origin: 'http://evil.test' };
    expect(
      (
        await relay(
          config,
          post('identity/seller/sign-in', otherOrigin),
          ['identity', 'seller', 'sign-in'],
          fetchImpl,
        )
      ).status,
    ).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an Authorization header', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/seller/sign-in', { ...sameOrigin, authorization: 'Bearer x' }),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a body over 16 KB', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/seller/sign-in', sameOrigin, 'x'.repeat(16 * 1024 + 1)),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(413);
  });

  it('refuses a streamed body over the cap without a Content-Length', async () => {
    const fetchImpl = upstreamOk();
    const big = new Uint8Array(16 * 1024 + 1).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.slice(0, 8000));
        controller.enqueue(big.slice(8000));
        controller.close();
      },
    });
    const request = new Request('http://seller.localhost:3001/api/identity/seller/sign-in', {
      method: 'POST',
      headers: sameOrigin,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = await relay(config, request, ['identity', 'seller', 'sign-in'], fetchImpl);
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses at once when Content-Length is over the cap', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/seller/sign-in', { ...sameOrigin, 'content-length': '99999' }),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends only allowlisted headers and the Market of the host', async () => {
    const fetchImpl = upstreamOk();
    await relay(
      config,
      post('identity/seller/sign-in', {
        ...sameOrigin,
        cookie: 'a=b',
        'x-market-id': 'NZ',
        'x-forwarded-for': '1.2.3.4',
        'x-csrf-token': 't',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0',
      }),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    const init = fetchImpl.mock.calls[0]![1]!;
    const sent = init.headers as Headers;
    expect(sent.get('x-market-id')).toBe('AU');
    expect(sent.get('cookie')).toBe('a=b');
    expect(sent.get('x-csrf-token')).toBe('t');
    // The API reduces it to a browser and system code on a new session (profile).
    expect(sent.get('user-agent')).toBe('Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0');
    expect(sent.has('x-forwarded-for')).toBe(false);
    expect(sent.has('host')).toBe(false);
  });

  it('relays every Set-Cookie and defaults to no-store', async () => {
    const upstream = new Response('{}', { status: 200 });
    upstream.headers.append('set-cookie', '__Host-session-seller-AU=abc; Path=/; Secure; HttpOnly');
    upstream.headers.append('set-cookie', 'other=1; Path=/');
    const response = await relay(
      config,
      post('identity/seller/sign-in'),
      ['identity', 'seller', 'sign-in'],
      () => Promise.resolve(upstream),
    );
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('always sets nosniff, because the proxy does not run on the relay', async () => {
    const response = await relay(
      config,
      post('identity/seller/sign-in'),
      ['identity', 'seller', 'sign-in'],
      () => Promise.resolve(new Response('{}', { status: 200 })),
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers 503 when the API is unreachable', async () => {
    const response = await relay(
      config,
      post('identity/seller/sign-in'),
      ['identity', 'seller', 'sign-in'],
      () => Promise.reject(new Error('down')),
    );
    expect(response.status).toBe(503);
  });
});

describe('signed client address (ADR-0037)', () => {
  const key = {
    keyId: 'panel',
    secret: Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64'),
  };
  const signing: PanelConfig = { ...config, clientAddressKey: key };
  const host = config.hosts[0]!;
  const at = () => 1791417600_000;
  const signed =
    'v1;k=panel;t=1791417600;a=203.0.113.7;s=VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8';

  it('sends no header when no key is set', () => {
    const request = new Request('http://seller.localhost:3001/', {
      headers: { 'x-mp-client-address': '203.0.113.7', 'x-client-address': 'forged' },
    });
    expect(upstreamHeaders(request, host, config, at).has('x-client-address')).toBe(false);
  });

  it('signs the address set by the panel server and overwrites a browser-sent header', () => {
    const request = new Request('http://seller.localhost:3001/', {
      headers: { 'x-mp-client-address': '203.0.113.7', 'x-client-address': 'forged' },
    });
    const headers = upstreamHeaders(request, host, signing, at);
    expect(headers.get('x-client-address')).toBe(signed);
    expect(headers.has('x-mp-client-address')).toBe(false);
  });

  it('refuses to relay without x-mp-client-address, and the API is never called', async () => {
    const upstream = upstreamOk();
    const log = vi.fn();
    const response = await relay(
      signing,
      post('identity/seller/sign-in', { ...sameOrigin, 'x-client-address': 'forged' }),
      ['identity', 'seller', 'sign-in'],
      upstream,
      log,
    );
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('sends the signed header on a relayed request', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      signing,
      post('identity/seller/sign-in', { ...sameOrigin, 'x-mp-client-address': '203.0.113.7' }),
      ['identity', 'seller', 'sign-in'],
      upstream,
      vi.fn(),
    );
    expect(response.status).toBe(200);
    // The vectors fix t, so only the shape is checked here; the signature has its own vectors.
    const sent = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(sent.get('x-client-address')).toMatch(/^v1;k=panel;t=\d+;a=203\.0\.113\.7;s=/);
  });
});

describe('relay allowlist for the store settings', () => {
  const request = (method: string, path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method,
      headers: sameOrigin,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

  it('relays the settings read (GET) on its exact path, and no longer the delivery write', async () => {
    const upstream = upstreamOk();
    const read = await relay(
      config,
      request('GET', 'sellers/store-settings'),
      ['sellers', 'store-settings'],
      upstream,
    );
    const write = await relay(
      config,
      request('PUT', 'sellers/store-settings/delivery'),
      ['sellers', 'store-settings', 'delivery'],
      upstream,
    );
    expect([read.status, write.status]).toEqual([200, 404]);
  });

  it('refuses every other method and shape near them', async () => {
    const upstream = upstreamOk();
    for (const [method, path] of [
      ['POST', ['sellers', 'store-settings']],
      ['PUT', ['sellers', 'store-settings']],
      ['GET', ['sellers', 'store-settings', 'delivery']],
      ['POST', ['sellers', 'store-settings', 'delivery']],
      ['DELETE', ['sellers', 'store-settings', 'delivery']],
      ['PUT', ['sellers', 'store-settings', 'delivery', 'x']],
      // The minimum order has no panel route yet: it stays closed until its tab is built.
      ['PUT', ['sellers', 'store-settings', 'minimum-order']],
    ] as const) {
      const response = await relay(config, request(method, path.join('/')), [...path], upstream);
      expect([method, path.join('/'), response.status]).toEqual([method, path.join('/'), 404]);
    }
  });
});

describe('relay allowlist for stock locations', () => {
  const put = (path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method: 'PUT',
      headers: sameOrigin,
      body: '{}',
    });
  const ID = '0190a000-0000-7000-8000-0000000000a1';

  it('relays the list read (GET) so a page can re-read it after a stale write', async () => {
    const read = new Request('http://seller.localhost:3001/api/inventory/seller/sources', {
      headers: sameOrigin,
    });
    expect(
      (await relay(config, read, ['inventory', 'seller', 'sources'], upstreamOk())).status,
    ).toBe(200);
    for (const tail of ['extra', ID]) {
      const other = new Request(
        `http://seller.localhost:3001/api/inventory/seller/sources/${tail}`,
        {
          headers: sameOrigin,
        },
      );
      expect(
        (await relay(config, other, ['inventory', 'seller', 'sources', tail], upstreamOk())).status,
      ).toBe(404);
    }
  });

  it('relays a location edit by UUID and the order, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    expect((await relay(config, put(`inventory/seller/sources/${ID}`), [], upstream)).status).toBe(
      404,
    );
    const ok = await relay(
      config,
      put(`inventory/seller/sources/${ID}`),
      ['inventory', 'seller', 'sources', ID],
      upstream,
    );
    expect(ok.status).toBe(200);
    expect(
      (await relay(config, put('x'), ['inventory', 'seller', 'sources-order'], upstream)).status,
    ).toBe(200);
    for (const path of [
      ['inventory', 'seller', 'sources', 'not-a-uuid'],
      ['inventory', 'seller', 'sources', ID, 'stock'],
      ['inventory', 'seller', 'offers', ID],
    ]) {
      expect((await relay(config, put('x'), path, upstream)).status).toBe(404);
    }
  });
  it('relays a product draft save and submit by UUID, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    const base = ['catalog', 'seller', 'products', ID];
    const post = (path: string[]) =>
      new Request(`http://seller.localhost:3001/api/${path.join('/')}`, {
        method: 'POST',
        headers: sameOrigin,
        body: '{}',
      });
    const draft = [...base, 'draft'];
    const submit = [...base, 'submit'];
    expect((await relay(config, put(draft.join('/')), draft, upstream)).status).toBe(200);
    expect((await relay(config, post(submit), submit, upstream)).status).toBe(200);
    expect((await relay(config, post(draft), draft, upstream)).status).toBe(404);
    expect((await relay(config, put(submit.join('/')), submit, upstream)).status).toBe(404);
    const bad = ['catalog', 'seller', 'products', 'x', 'draft'];
    expect((await relay(config, put(bad.join('/')), bad, upstream)).status).toBe(404);
  });
  it('relays add-sizes as a POST by UUID only, and neither a GET of it nor an impact read', async () => {
    const upstream = upstreamOk();
    const send = (method: string, path: string[]) =>
      relay(
        config,
        new Request(`http://seller.localhost:3001/api/${path.join('/')}`, {
          method,
          headers: sameOrigin,
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
        path,
        upstream,
      );
    const sizes = ['catalog', 'seller', 'products', ID, 'add-sizes'];
    expect((await send('POST', sizes)).status).toBe(200);
    expect((await send('GET', sizes)).status).toBe(404);
    expect((await send('PUT', sizes)).status).toBe(404);
    expect((await send('POST', ['catalog', 'seller', 'products', 'x', 'add-sizes'])).status).toBe(
      404,
    );
    // The seller route never asks for a count, so there is no impact read to relay.
    const impact = ['catalog', 'seller', 'products', ID, 'add-sizes-impact'];
    expect((await send('POST', impact)).status).toBe(404);
    expect((await send('GET', impact)).status).toBe(404);
  });
  it('relays an offer edit and a stock level write by UUID, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    const offer = ['catalog', 'seller', 'offers', ID];
    const stock = ['inventory', 'seller', 'offers', ID, 'variants', ID, 'sources', ID, 'stock'];
    expect((await relay(config, put(offer.join('/')), offer, upstream)).status).toBe(200);
    expect((await relay(config, put(stock.join('/')), stock, upstream)).status).toBe(200);
    const bad = [
      ['catalog', 'seller', 'offers', 'x'],
      ['inventory', 'seller', 'offers', ID, 'variants', 'x', 'sources', ID, 'stock'],
      ['inventory', 'seller', 'offers', ID, 'variants', ID, 'sources', ID],
    ];
    for (const path of bad) {
      expect((await relay(config, put(path.join('/')), path, upstream)).status).toBe(404);
    }
  });
  it('relays a sell-units write by UUID, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    const units = ['catalog', 'seller', 'offers', ID, 'sell-units'];
    expect((await relay(config, put(units.join('/')), units, upstream)).status).toBe(200);
    const bad = [
      ['catalog', 'seller', 'offers', 'x', 'sell-units'],
      ['catalog', 'seller', 'offers', ID, 'sell-units', 'x'],
    ];
    for (const path of bad) {
      expect((await relay(config, put(path.join('/')), path, upstream)).status).toBe(404);
    }
    // The page reads the units on the server; the browser relay carries only the write.
    const read = new Request(`http://seller.localhost:3001/api/${units.join('/')}`, {
      method: 'GET',
      headers: sameOrigin,
    });
    expect((await relay(config, read, units, upstream)).status).toBe(404);
  });
  it('relays a regular price write by UUID, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    const price = ['pricing', 'seller', 'offers', ID, 'variants', ID, 'regular-price'];
    expect((await relay(config, put(price.join('/')), price, upstream)).status).toBe(200);
    const bad = [
      ['pricing', 'seller', 'offers', 'x', 'variants', ID, 'regular-price'],
      ['pricing', 'seller', 'offers', ID, 'variants', ID, 'special-price', 'x'],
      ['pricing', 'seller', 'offers', ID, 'prices'],
    ];
    for (const path of bad) {
      expect((await relay(config, put(path.join('/')), path, upstream)).status).toBe(404);
    }
  });
  it('relays special price set and withdraw by UUID', async () => {
    const upstream = upstreamOk();
    const special = ['pricing', 'seller', 'offers', ID, 'variants', ID, 'special-price'];
    const withdraw = [...special, 'withdraw'];
    expect((await relay(config, put(special.join('/')), special, upstream)).status).toBe(200);
    const withdrawal = new Request(`http://seller.localhost:3001/api/${withdraw.join('/')}`, {
      method: 'POST',
      headers: sameOrigin,
      body: '{}',
    });
    expect((await relay(config, withdrawal, withdraw, upstream)).status).toBe(200);
    const bad = ['pricing', 'seller', 'offers', 'x', 'variants', ID, 'special-price', 'withdraw'];
    const refused = new Request(`http://seller.localhost:3001/api/${bad.join('/')}`, {
      method: 'POST',
      headers: sameOrigin,
      body: '{}',
    });
    expect((await relay(config, refused, bad, upstream)).status).toBe(404);
  });
  it('relays an offer submit (POST) and delete (DELETE) by UUID only', async () => {
    const upstream = upstreamOk();
    const req = (method: string, path: string[]) =>
      new Request(`http://seller.localhost:3001/api/${path.join('/')}`, {
        method,
        headers: sameOrigin,
        ...(method === 'DELETE' ? {} : { body: '{}' }),
      });
    const submit = ['catalog', 'seller', 'offers', ID, 'submit'];
    const one = ['catalog', 'seller', 'offers', ID];
    expect((await relay(config, req('POST', submit), submit, upstream)).status).toBe(200);
    expect((await relay(config, req('DELETE', one), one, upstream)).status).toBe(200);
    const refused: [string, string[]][] = [
      ['POST', ['catalog', 'seller', 'offers', 'x', 'submit']],
      ['DELETE', ['catalog', 'seller', 'offers', 'x']],
      ['DELETE', ['catalog', 'seller', 'offers']],
      ['DELETE', submit],
      ['POST', one],
      ['DELETE', ['catalog', 'seller', 'products', ID]],
    ];
    for (const [method, path] of refused) {
      expect((await relay(config, req(method, path), path, upstream)).status).toBe(404);
    }
  });
});

describe('relay product photo paths', () => {
  const PRODUCT = '01990000-0000-7000-8000-00000000c001';
  const IMAGE = '01990000-0000-7000-8000-00000000d001';
  const uploadPath = ['catalog', 'seller', 'products', PRODUCT, 'images'];

  it('takes a photo upload of 1 MiB, where every other body stops at 16 KB', async () => {
    const upstream = upstreamOk();
    const photoBody = JSON.stringify({ data: 'A'.repeat(1024 * 1024) });
    const response = await relay(
      config,
      post(uploadPath.join('/'), sameOrigin, photoBody),
      uploadPath,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);

    const other = upstreamOk();
    const refused = await relay(
      config,
      post(`catalog/seller/products/${PRODUCT}/submit`, sameOrigin, photoBody),
      ['catalog', 'seller', 'products', PRODUCT, 'submit'],
      other,
    );
    expect(refused.status).toBe(413);
    expect(other).not.toHaveBeenCalled();
  });

  it('refuses a photo upload over 5.8 MiB', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      post(uploadPath.join('/'), sameOrigin, 'A'.repeat(5800 * 1024 + 1)),
      uploadPath,
      upstream,
    );
    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays a photo read for the three sizes only, and a delete', async () => {
    const read = (size: string) =>
      new Request(
        `http://seller.localhost:3001/api/catalog/seller/products/${PRODUCT}/images/${IMAGE}/${size}`,
        { headers: { host: sameOrigin.host } },
      );
    for (const size of ['thumb', 'medium', 'large']) {
      const upstream = upstreamOk();
      const response = await relay(
        config,
        read(size),
        ['catalog', 'seller', 'products', PRODUCT, 'images', IMAGE, size],
        upstream,
      );
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
    }
    const upstream = upstreamOk();
    const huge = await relay(
      config,
      read('huge'),
      ['catalog', 'seller', 'products', PRODUCT, 'images', IMAGE, 'huge'],
      upstream,
    );
    expect(huge.status).toBe(404);

    const remove = new Request(
      `http://seller.localhost:3001/api/catalog/seller/products/${PRODUCT}/images/${IMAGE}`,
      { method: 'DELETE', headers: sameOrigin },
    );
    const deleted = await relay(
      config,
      remove,
      ['catalog', 'seller', 'products', PRODUCT, 'images', IMAGE],
      upstream,
    );
    expect(deleted.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('refuses a photo path whose product id is not a UUID', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      post('catalog/seller/products/not-a-uuid/images'),
      ['catalog', 'seller', 'products', 'not-a-uuid', 'images'],
      upstream,
    );
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the payout account', () => {
  const get = (path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method: 'GET',
      headers: { host: 'seller.localhost:3001' },
    });

  it('reads the account and posts connect and link, and nothing else under it', async () => {
    const upstream = upstreamOk();
    const base = ['payments', 'seller', 'payout-account'];
    expect((await relay(config, get(base.join('/')), base, upstream)).status).toBe(200);
    expect((await relay(config, post(base.join('/')), base, upstream)).status).toBe(200);
    const link = [...base, 'link'];
    expect((await relay(config, post(link.join('/')), link, upstream)).status).toBe(200);
    expect((await relay(config, get(link.join('/')), link, upstream)).status).toBe(404);
    const other = [...base, 'other'];
    expect((await relay(config, post(other.join('/')), other, upstream)).status).toBe(404);
  });
});

describe('relay of the seller order routes', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = (query: string) =>
    new Request(`http://seller.localhost:3001/api/ordering/seller/orders${query}`, {
      method: 'GET',
      headers: { host: 'seller.localhost:3001' },
    });
  const list = ['ordering', 'seller', 'orders'];

  it('lists orders and forwards only limit and cursor', async () => {
    const upstream = upstreamOk();
    expect((await relay(config, get('?limit=20&cursor=c1&x=1'), list, upstream)).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/ordering/seller/orders?limit=20&cursor=c1',
    );
  });

  it('posts ship and deliver by UUID, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    for (const action of ['ship', 'deliver']) {
      const path = [...list, ID, action];
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
    }
    for (const path of [[...list, 'x', 'ship'], [...list, ID, 'cancel'], [...list, ID], list]) {
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
    }
  });
});

describe('relay of the seller ledger route', () => {
  const path = ['commission-payouts', 'seller', 'ledger'];
  const request = (method: string, query = '') =>
    new Request(`http://seller.localhost:3001/api/${path.join('/')}${query}`, {
      method,
      headers: { host: 'seller.localhost:3001' },
    });

  it('reads the ledger forwarding only limit and cursor', async () => {
    const upstream = upstreamOk();
    const answer = await relay(config, request('GET', '?limit=20&cursor=c1&x=1'), path, upstream);
    expect(answer.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/commission-payouts/seller/ledger?limit=20&cursor=c1',
    );
  });

  it('refuses every other method and path under it', async () => {
    expect((await relay(config, request('POST'), path, upstreamOk())).status).toBe(404);
    const other = [...path, 'x'];
    expect((await relay(config, request('GET'), other, upstreamOk())).status).toBe(404);
  });
});

describe('relay of the seller payout routes', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const read = (route: string, query = '') =>
    relay(
      config,
      new Request(`http://seller.localhost:3001/api/commission-payouts/seller/${route}${query}`, {
        method: 'GET',
        headers: { host: 'seller.localhost:3001' },
      }),
      ['commission-payouts', 'seller', ...route.split('/')],
      upstreamOk(),
    );

  it.each(['payouts/next', 'payouts', 'payout-holds'])('reads %s', async (route) => {
    expect((await read(route)).status).toBe(200);
  });

  it('forwards the history limit and a cursor in the API shape, and nothing else', async () => {
    const upstream = upstreamOk();
    const cursor = `1790000000000.${ID}`;
    await relay(
      config,
      new Request(
        `http://seller.localhost:3001/api/commission-payouts/seller/payouts?limit=20&cursor=${cursor}&sellerId=x`,
        { method: 'GET', headers: { host: 'seller.localhost:3001' } },
      ),
      ['commission-payouts', 'seller', 'payouts'],
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/seller/payouts?limit=20&cursor=${encodeURIComponent(cursor)}`,
    );
    const bad = upstreamOk();
    await relay(
      config,
      new Request(
        'http://seller.localhost:3001/api/commission-payouts/seller/payouts?limit=99999&cursor=a%20b',
        { method: 'GET', headers: { host: 'seller.localhost:3001' } },
      ),
      ['commission-payouts', 'seller', 'payouts'],
      bad,
    );
    expect(bad.mock.calls[0]?.[0]).toBe('http://api.test/commission-payouts/seller/payouts');
  });

  it('does not relay the admin routes, a write or any other path under it', async () => {
    for (const path of [
      ['commission-payouts', 'admin', 'payouts'],
      ['commission-payouts', 'seller', 'payouts', ID],
      ['commission-payouts', 'seller', 'payouts', 'next', 'x'],
    ]) {
      const upstream = upstreamOk();
      const request = new Request(`http://seller.localhost:3001/api/${path.join('/')}`, {
        method: 'GET',
        headers: { host: 'seller.localhost:3001' },
      });
      expect((await relay(config, request, path, upstream)).status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    }
    const upstream = upstreamOk();
    const path = ['commission-payouts', 'seller', 'payouts'];
    expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the seller team routes', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const team = ['identity', 'seller', 'team'];
  const get = (path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method: 'GET',
      headers: { host: 'seller.localhost:3001' },
    });

  it('lists the team forwarding only `after`, and reads the roles without a query', async () => {
    const upstream = upstreamOk();
    expect(
      (await relay(config, get(`${team.join('/')}?after=${ID}&limit=1`), team, upstream)).status,
    ).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/identity/seller/team?after=${ID}`);
    await relay(config, get(`${team.join('/')}?after=not-a-uuid`), team, upstream);
    expect(upstream.mock.calls.at(-1)?.[0]).toBe('http://api.test/identity/seller/team');
    const roles = ['identity', 'seller', 'roles'];
    expect((await relay(config, get('identity/seller/roles?x=1'), roles, upstream)).status).toBe(
      200,
    );
    expect(upstream.mock.calls.at(-1)?.[0]).toBe('http://api.test/identity/seller/roles');
    expect((await relay(config, post('identity/seller/roles'), roles, upstream)).status).toBe(404);
  });

  it('posts an invitation and the anonymous acceptance, and nothing near them', async () => {
    const upstream = upstreamOk();
    for (const path of [
      [...team, 'invitations'],
      ['identity', 'seller', 'accept-invitation'],
    ]) {
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
    }
    for (const path of [
      [...team, 'invitations', 'x'],
      [...team, 'accounts'],
      ['identity', 'seller', 'accept-invitation', 'x'],
      team,
    ]) {
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
    }
    const list = [...team, 'invitations'];
    expect((await relay(config, get(list.join('/')), list, upstream)).status).toBe(404);
  });

  it('posts resend, revoke, role and remove by UUID only', async () => {
    const upstream = upstreamOk();
    for (const tail of [
      ['invitations', ID, 'resend'],
      ['invitations', ID, 'revoke'],
      ['accounts', ID, 'role'],
      ['accounts', ID, 'remove'],
    ]) {
      const path = [...team, ...tail];
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
    }
    for (const tail of [
      ['invitations', 'x', 'resend'],
      ['accounts', 'x', 'remove'],
      ['invitations', ID, 'remove'],
      ['accounts', ID, 'resend'],
      ['accounts', ID],
      ['accounts', ID, 'role', 'x'],
    ]) {
      const path = [...team, ...tail];
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
    }
    const path = [...team, 'accounts', ID, 'remove'];
    expect((await relay(config, get(path.join('/')), path, upstream)).status).toBe(404);
  });
});

describe('relay of the seller notice routes', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const notices = ['notifications', 'seller', 'notices'];
  const get = (path: readonly string[], query = '') =>
    new Request(`http://seller.localhost:3001/api/${path.join('/')}${query}`, {
      method: 'GET',
      headers: { host: 'seller.localhost:3001' },
    });

  it('lists notices forwarding only a valid `show` and `before`, and reads the count', async () => {
    const upstream = upstreamOk();
    const query = `?show=read&before=${ID}&x=1`;
    expect((await relay(config, get(notices, query), notices, upstream)).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/notifications/seller/notices?show=read&before=${ID}`,
    );
    await relay(config, get(notices, '?show=everything&before=x'), notices, upstream);
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/notifications/seller/notices');
    const count = [...notices, 'unread-count'];
    expect((await relay(config, get(count), count, upstream)).status).toBe(200);
  });

  it('posts read-all and one read by UUID, same-origin only, and nothing near them', async () => {
    const upstream = upstreamOk();
    for (const path of [
      [...notices, 'read-all'],
      [...notices, ID, 'read'],
    ]) {
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
      const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
      expect((await relay(config, post(path.join('/'), crossSite), path, upstream)).status).toBe(
        403,
      );
    }
    for (const path of [
      [...notices, 'x', 'read'],
      [...notices, ID, 'delete'],
      [...notices, ID],
      notices,
      [...notices, 'unread-count'],
    ]) {
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
    }
  });
});

describe('relay of the store profile', () => {
  const IMAGE = '01990000-0000-7000-8000-00000000d001';
  const call = (
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = sameOrigin,
  ) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  const send = (method: string, path: string, body?: string) =>
    relay(config, call(method, path, body), path.split('/'), upstreamOk());

  it('relays the read, the About save, the two image saves and the two removes', async () => {
    expect((await send('GET', 'sellers/store-profile')).status).toBe(200);
    expect((await send('PUT', 'sellers/store-profile/about', '{}')).status).toBe(200);
    expect((await send('PUT', 'sellers/store-profile', '{}')).status).toBe(200);
    for (const kind of ['logo', 'banner']) {
      expect((await send('PUT', `sellers/store-profile/${kind}`, '{}')).status).toBe(200);
      expect((await send('DELETE', `sellers/store-profile/${kind}`)).status).toBe(200);
    }
  });

  it('refuses other shapes under it: the wrong method, an unknown image kind, a seller id', async () => {
    const refused: [string, string][] = [
      ['POST', 'sellers/store-profile'],
      ['DELETE', 'sellers/store-profile'],
      ['POST', 'sellers/store-profile/about'],
      ['DELETE', 'sellers/store-profile/about'],
      ['PUT', 'sellers/store-profile/avatar'],
      ['DELETE', 'sellers/store-profile/avatar'],
      ['GET', `sellers/store-profile/${IMAGE}`],
      ['GET', 'sellers/store-profile/logo'],
    ];
    for (const [method, path] of refused) {
      const upstream = upstreamOk();
      const body = method === 'GET' ? undefined : '{}';
      const response = await relay(config, call(method, path, body), path.split('/'), upstream);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    }
  });

  it('takes a logo or banner body of 1 MiB, where the About save stops at 16 KB', async () => {
    const big = JSON.stringify({ data: 'A'.repeat(1024 * 1024) });
    expect((await send('PUT', 'sellers/store-profile/logo', big)).status).toBe(200);
    expect((await send('PUT', 'sellers/store-profile/banner', big)).status).toBe(200);
    expect((await send('PUT', 'sellers/store-profile/about', big)).status).toBe(413);
    expect(
      (await send('PUT', 'sellers/store-profile/logo', 'A'.repeat(5800 * 1024 + 1))).status,
    ).toBe(413);
  });

  it('takes the whole-profile save up to two photo bodies, and no more', async () => {
    const two = JSON.stringify({ about: {}, logo: { data: 'A'.repeat(5000 * 1024) } });
    expect((await send('PUT', 'sellers/store-profile', two)).status).toBe(200);
    expect(
      (await send('PUT', 'sellers/store-profile', 'A'.repeat(2 * 5800 * 1024 + 1))).status,
    ).toBe(413);
    // Only the whole-profile route gets that room: the About save stays at 16 KB.
    expect((await send('PUT', 'sellers/store-profile/about', two)).status).toBe(413);
  });

  it('relays an image read for small and large by UUID, and refuses other sizes and ids', async () => {
    for (const size of ['small', 'large']) {
      const path = `sellers/store-profile/images/${IMAGE}/${size}`;
      expect((await send('GET', path)).status).toBe(200);
    }
    for (const path of [
      `sellers/store-profile/images/${IMAGE}/huge`,
      'sellers/store-profile/images/not-a-uuid/small',
    ]) {
      expect((await send('GET', path)).status).toBe(404);
    }
  });

  it('refuses an unsafe request that is not same-origin', async () => {
    const upstream = upstreamOk();
    const path = 'sellers/store-profile/about';
    const response = await relay(
      config,
      call('PUT', path, '{}', { ...sameOrigin, 'sec-fetch-site': 'cross-site' }),
      path.split('/'),
      upstream,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay allowlist for the seller tag list', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const send = (method: string, path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method,
      headers: sameOrigin,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

  it('relays the read with search, afterId and limit, and drops other query keys', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      send('GET', `catalog/seller/topics?search=eid&afterId=${ID}&limit=100&status=archived&x=1`),
      ['catalog', 'seller', 'topics'],
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/seller/topics?search=eid&afterId=${ID}&limit=100`,
    );
  });

  it('drops a malformed afterId and limit', async () => {
    const bad = upstreamOk();
    await relay(
      config,
      send('GET', 'catalog/seller/topics?afterId=nope&limit=abc'),
      ['catalog', 'seller', 'topics'],
      bad,
    );
    expect(bad.mock.calls[0]?.[0]).toBe('http://api.test/catalog/seller/topics');
  });

  it('relays no write and no id path', async () => {
    for (const [method, path] of [
      ['POST', 'catalog/seller/topics'],
      ['PUT', `catalog/seller/topics/${ID}`],
      ['GET', `catalog/seller/topics/${ID}`],
      ['DELETE', 'catalog/seller/topics'],
    ] as const) {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, path), path.split('/'), upstream);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(upstream).not.toHaveBeenCalled();
    }
  });
});

describe('relay allowlist for the seller reviews', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const send = (method: string, path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method,
      headers: sameOrigin,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

  it('relays the list read with its cursor and drops other query keys', async () => {
    const upstream = upstreamOk();
    const cursor = `1760000000000_${ID}`;
    const response = await relay(
      config,
      send('GET', `reviews/seller?cursor=${cursor}&limit=500&x=1`),
      ['reviews', 'seller'],
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/reviews/seller?cursor=${cursor}`);
    const bad = upstreamOk();
    await relay(config, send('GET', 'reviews/seller?cursor=nonsense'), ['reviews', 'seller'], bad);
    expect(bad.mock.calls[0]?.[0]).toBe('http://api.test/reviews/seller');
  });

  it('relays reply (POST and PATCH) and report (POST) by UUID, and refuses other shapes', async () => {
    const upstream = upstreamOk();
    const ok = [
      ['POST', ['reviews', 'seller', ID, 'reply']],
      ['PATCH', ['reviews', 'seller', ID, 'reply']],
      ['POST', ['reviews', 'seller', ID, 'report']],
    ] as const;
    for (const [method, path] of ok) {
      expect((await relay(config, send(method, 'x'), [...path], upstream)).status).toBe(200);
    }
    for (const [method, path] of [
      ['PUT', ['reviews', 'seller', ID, 'reply']],
      ['DELETE', ['reviews', 'seller', ID, 'reply']],
      ['PATCH', ['reviews', 'seller', ID, 'report']],
      ['POST', ['reviews', 'seller', 'not-a-uuid', 'reply']],
      ['POST', ['reviews', 'seller', ID, 'hide']],
      ['POST', ['reviews', 'admin', 'settings']],
      ['POST', ['reviews', 'products']],
    ] as const) {
      expect((await relay(config, send(method, 'x'), [...path], upstream)).status).toBe(404);
    }
  });

  it("relays only the seller's own value suggestion write", async () => {
    const upstream = upstreamOk();
    const path = ['catalog', 'seller', 'products', ID, 'attribute-suggestions'];
    expect((await relay(config, send('POST', 'x'), path, upstream)).status).toBe(200);
    for (const [method, bad] of [
      ['GET', path],
      ['PUT', path],
      ['POST', ['catalog', 'seller', 'products', 'not-a-uuid', 'attribute-suggestions']],
      ['POST', ['catalog', 'admin', 'attribute-suggestions']],
      ['POST', [...path, 'approve']],
    ] as const) {
      expect((await relay(config, send(method, 'x'), [...bad], upstream)).status).toBe(404);
    }
  });

  it('refuses a cross-site PATCH of a reply', async () => {
    const request = new Request(`http://seller.localhost:3001/api/reviews/seller/${ID}/reply`, {
      method: 'PATCH',
      headers: { ...sameOrigin, 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    const response = await relay(config, request, ['reviews', 'seller', ID, 'reply'], upstreamOk());
    expect(response.status).toBe(403);
  });
});

describe('relay of the seller import routes (catalog design 14c)', () => {
  const ID = '0190a000-0000-7000-8000-0000000000b1';
  const BASE = 'catalog/seller/imports';
  const send = (method: string, path: string, body = '{}') =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method,
      headers: sameOrigin,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    });
  const run = async (method: string, path: string, body?: string) => {
    const upstream = upstreamOk();
    const segments = (path.split('?')[0] ?? '').split('/');
    const response = await relay(config, send(method, path, body), segments, upstream);
    return { response, upstream };
  };

  it.each([
    ['GET', `${BASE}/template`],
    ['GET', `${BASE}/current`],
    ['GET', `${BASE}/${ID}`],
    ['GET', `${BASE}/${ID}/report?kind=errors`],
    ['POST', BASE],
    ['POST', `${BASE}/${ID}/start`],
    ['POST', `${BASE}/${ID}/resume`],
    ['POST', `${BASE}/${ID}/discard`],
    ['POST', `${BASE}/${ID}/photos`],
  ])('relays %s %s', async (method, path) => {
    const { response, upstream } = await run(method, path);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['PUT', BASE],
    ['DELETE', BASE],
    ['PATCH', `${BASE}/${ID}`],
    ['PUT', `${BASE}/${ID}`],
    ['DELETE', `${BASE}/${ID}`],
    ['POST', `${BASE}/${ID}`],
    ['POST', `${BASE}/template`],
    ['POST', `${BASE}/current`],
    ['GET', BASE],
    ['GET', `${BASE}/${ID}/start`],
    ['GET', `${BASE}/${ID}/resume`],
    ['GET', `${BASE}/${ID}/discard`],
    ['GET', `${BASE}/${ID}/photos`],
    ['POST', `${BASE}/${ID}/report`],
    ['PUT', `${BASE}/${ID}/photos`],
    ['DELETE', `${BASE}/${ID}/photos`],
    ['PUT', `${BASE}/${ID}/start`],
    ['GET', `${BASE}/not-a-uuid`],
    ['POST', `${BASE}/not-a-uuid/start`],
    ['POST', `${BASE}/${ID}/photos/extra`],
    ['POST', `${BASE}/${ID}/other`],
  ])('refuses %s %s', async (method, path) => {
    const { response, upstream } = await run(method, path);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only a valid report kind', async () => {
    for (const kind of ['errors', 'full']) {
      const { upstream } = await run('GET', `${BASE}/${ID}/report?kind=${kind}&x=1`);
      expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${BASE}/${ID}/report?kind=${kind}`);
    }
    const bad = await run('GET', `${BASE}/${ID}/report?kind=everything`);
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${BASE}/${ID}/report`);
    const poll = await run('GET', `${BASE}/${ID}?kind=full`);
    expect(poll.upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${BASE}/${ID}`);
  });

  it('takes the file upload up to its cap and the photo body up to 5.8 MiB, and no other body above 16 KB', async () => {
    const file = JSON.stringify({ mode: 'my-products', data: 'A'.repeat(13 * 1024 * 1024) });
    const uploaded = await run('POST', BASE, file);
    expect(uploaded.response.status).toBe(200);
    const over = await run('POST', BASE, 'A'.repeat(14500 * 1024 + 1));
    expect(over.response.status).toBe(413);
    expect(over.upstream).not.toHaveBeenCalled();

    const photo = await run(
      'POST',
      `${BASE}/${ID}/photos`,
      JSON.stringify({ data: 'A'.repeat(5 * 1024 * 1024) }),
    );
    expect(photo.response.status).toBe(200);
    const tooBig = await run('POST', `${BASE}/${ID}/photos`, 'A'.repeat(5800 * 1024 + 1));
    expect(tooBig.response.status).toBe(413);

    const start = await run('POST', `${BASE}/${ID}/start`, 'A'.repeat(17 * 1024));
    expect(start.response.status).toBe(413);
    expect(start.upstream).not.toHaveBeenCalled();
  });

  it('refuses an unsafe import request that is not same-origin', async () => {
    const upstream = upstreamOk();
    const cross = new Request(`http://seller.localhost:3001/api/${BASE}/${ID}/start`, {
      method: 'POST',
      headers: { ...sameOrigin, 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    const response = await relay(config, cross, [...BASE.split('/'), ID, 'start'], upstream);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes the CSV report back with its type and nosniff', async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('row,code\n1,ok\n', {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        }),
      ),
    );
    const response = await relay(
      config,
      send('GET', `${BASE}/${ID}/report?kind=full`),
      [...BASE.split('/'), ID, 'report'],
      upstream,
    );
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('row,code\n1,ok\n');
  });
});

describe('relay of the seller product list', () => {
  const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';
  const list = ['catalog', 'seller', 'products'];
  const get = (query: string) =>
    new Request(`http://seller.localhost:3001/api/catalog/seller/products${query}`, {
      method: 'GET',
      headers: { host: 'seller.localhost:3001' },
    });

  it('forwards the list parameters and drops everything else, keyset ones included', async () => {
    const upstream = upstreamOk();
    const query =
      `?view=in-review&q=olive%20oil&status=draft&categoryId=${CATEGORY}&paused=true` +
      '&typeCode=grocery&sort=name&direction=asc&page=2&pageSize=50&afterId=x&limit=5&extra=1';
    expect((await relay(config, get(query), list, upstream)).status).toBe(200);
    const sent = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(sent.pathname).toBe('/catalog/seller/products');
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      view: 'in-review',
      q: 'olive oil',
      status: 'draft',
      categoryId: CATEGORY,
      paused: 'true',
      typeCode: 'grocery',
      sort: 'name',
      direction: 'asc',
      page: '2',
      pageSize: '50',
    });
  });

  it('drops a parameter with a value of the wrong shape, so the API never sees it', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      get('?view=everything&status=withdrawn&categoryId=x&paused=1&sort=price&page=-1&pageSize=30'),
      list,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/seller/products');
  });

  it('still relays a product photo thumbnail for the list', async () => {
    const upstream = upstreamOk();
    const path = ['catalog', 'seller', 'products', CATEGORY, 'images', CATEGORY, 'thumb'];
    const request = get(`/${CATEGORY}/images/${CATEGORY}/thumb`);
    expect((await relay(config, request, path, upstream)).status).toBe(200);
  });
});

describe('relay of the Products export and saved filters (catalog design 9.2c, 9.2d)', () => {
  const PRODUCT = '0190a000-0000-7000-8000-0000000000b1';
  const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';
  const FILTER = '0190a000-0000-7000-8000-0000000000f1';
  const EXPORT = ['catalog', 'seller', 'products', 'export'];
  const FILTERS = ['catalog', 'seller', 'saved-filters'];
  const get = (query: string, path = 'catalog/seller/products/export') =>
    new Request(`http://seller.localhost:3001/api/${path}${query}`, {
      method: 'GET',
      headers: { host: 'seller.localhost:3001' },
    });
  const write = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method,
      headers,
      ...(method === 'DELETE' ? {} : { body: '{"name":"x"}' }),
    });

  it('forwards the export selector, format, columns and ids, and drops the page and everything else', async () => {
    const upstream = upstreamOk();
    const ids = `${PRODUCT},${CATEGORY}`;
    const query =
      `?format=xlsx&columns=product,code,offers&productIds=${ids}&view=in-review&q=olive%20oil` +
      `&status=draft&categoryId=${CATEGORY}&paused=true&typeCode=grocery&sort=name&direction=asc` +
      '&page=2&pageSize=50&afterId=x&limit=5&extra=1';
    expect((await relay(config, get(query), EXPORT, upstream)).status).toBe(200);
    const sent = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(sent.pathname).toBe('/catalog/seller/products/export');
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      format: 'xlsx',
      columns: 'product,code,offers',
      productIds: ids,
      view: 'in-review',
      q: 'olive oil',
      status: 'draft',
      categoryId: CATEGORY,
      paused: 'true',
      typeCode: 'grocery',
      sort: 'name',
      direction: 'asc',
    });
  });

  it('passes 100 product ids and drops 101, or a malformed one', async () => {
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `0190a000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      ).join(',');
    const upstream = upstreamOk();
    await relay(config, get(`?productIds=${ids(100)}`), EXPORT, upstream);
    expect(new URL(upstream.mock.calls[0]?.[0] as string).searchParams.get('productIds')).toBe(
      ids(100),
    );
    await relay(config, get(`?productIds=${ids(101)}`), EXPORT, upstream);
    await relay(config, get(`?productIds=${PRODUCT},not-an-id`), EXPORT, upstream);
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/seller/products/export');
    expect(upstream.mock.calls[2]?.[0]).toBe('http://api.test/catalog/seller/products/export');
  });

  it('drops a parameter with a value of the wrong shape, so the API never sees it', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      get(
        '?format=pdf&columns=product,price&view=everything&status=withdrawn&categoryId=x&paused=1&sort=price&direction=up',
      ),
      EXPORT,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/seller/products/export');
  });

  it('passes the file back byte for byte, with its type and without its internal headers', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': 'attachment; filename="products-2026-11-07.xlsx"',
            'cache-control': 'no-store',
            'x-internal': 'secret',
          },
        }),
      ),
    );
    const response = await relay(config, get('?format=xlsx'), EXPORT, upstream);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // The panel names the file itself, so the API's file name header is not passed on.
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-internal')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('passes the export refusals back with their status and code', async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('{"code":"batch.too-large","details":{"max":10000,"total":12500}}', {
          status: 413,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const response = await relay(config, get(''), EXPORT, upstream);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: 'batch.too-large',
      details: { max: 10000, total: 12500 },
    });
  });

  it('refuses a write to the export, and the export of another population', async () => {
    const upstream = upstreamOk();
    expect(
      (await relay(config, write('POST', 'catalog/seller/products/export'), EXPORT, upstream))
        .status,
    ).toBe(404);
    expect(
      (
        await relay(
          config,
          get('', 'catalog/admin/products/export'),
          ['catalog', 'admin', 'products', 'export'],
          upstream,
        )
      ).status,
    ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards the list of saved filters with its listKey only', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get('?listKey=seller.catalog.products&extra=1', 'catalog/seller/saved-filters'),
      FILTERS,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/seller/saved-filters?listKey=seller.catalog.products',
    );
    await relay(
      config,
      get('?listKey=Bad Key!', 'catalog/seller/saved-filters'),
      FILTERS,
      upstream,
    );
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/seller/saved-filters');
  });

  it.each([
    ['POST', 'catalog/seller/saved-filters'],
    ['PUT', `catalog/seller/saved-filters/${FILTER}`],
    ['DELETE', `catalog/seller/saved-filters/${FILTER}`],
  ])('relays %s %s as a seller write: same origin, with the CSRF token', async (method, path) => {
    const upstream = upstreamOk();
    const headers = { ...sameOrigin, 'x-csrf-token': 'tok' };
    const response = await relay(config, write(method, path, headers), path.split('/'), upstream);
    expect(response.status).toBe(200);
    const sent = upstream.mock.calls[0]?.[1]?.headers as Headers;
    expect(sent.get('x-csrf-token')).toBe('tok');
    expect(upstream.mock.calls[0]?.[1]?.method).toBe(method);
  });

  it.each([
    ['POST', 'catalog/seller/saved-filters'],
    ['PUT', `catalog/seller/saved-filters/${FILTER}`],
    ['DELETE', `catalog/seller/saved-filters/${FILTER}`],
  ])('refuses %s %s from another origin, before the API', async (method, path) => {
    const upstream = upstreamOk();
    const headers = {
      ...sameOrigin,
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
    };
    const response = await relay(config, write(method, path, headers), path.split('/'), upstream);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', 'catalog/seller/saved-filters'],
    ['DELETE', 'catalog/seller/saved-filters'],
    ['PATCH', `catalog/seller/saved-filters/${FILTER}`],
    ['POST', `catalog/seller/saved-filters/${FILTER}`],
    ['GET', `catalog/seller/saved-filters/${FILTER}`],
    ['PUT', 'catalog/seller/saved-filters/not-a-uuid'],
    ['DELETE', 'catalog/seller/saved-filters/not-a-uuid'],
    ['PUT', `catalog/seller/saved-filters/${FILTER}/extra`],
    ['POST', 'catalog/admin/saved-filters'],
    ['GET', 'catalog/admin/saved-filters'],
  ])('refuses %s %s', async (method, path) => {
    const upstream = upstreamOk();
    const request =
      method === 'GET'
        ? get('', path)
        : write(method, path, { ...sameOrigin, 'x-csrf-token': 'tok' });
    const response = await relay(config, request, path.split('/'), upstream);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay allowlist for category proposals and shelves (categories C9b)', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const send = (method: string, path: string[]) =>
    relay(
      config,
      new Request(`http://seller.localhost:3001/api/${path.join('/')}`, {
        method,
        headers: sameOrigin,
        ...(method === 'GET' ? {} : { body: '{}' }),
      }),
      path,
      upstreamOk(),
    );

  it('relays the read, the propose POST, the cancel POST by UUID and the shelf PUT by UUID', async () => {
    const list = ['catalog', 'seller', 'category-proposals'];
    expect((await send('GET', list)).status).toBe(200);
    expect((await send('POST', list)).status).toBe(200);
    expect((await send('POST', [...list, ID, 'cancel'])).status).toBe(200);
    expect((await send('PUT', ['catalog', 'seller', 'offers', ID, 'shelf'])).status).toBe(200);
  });

  it('refuses other methods and shapes near them', async () => {
    const list = ['catalog', 'seller', 'category-proposals'];
    for (const [method, path] of [
      ['PUT', list],
      ['DELETE', list],
      ['GET', [...list, ID]],
      ['POST', [...list, 'x', 'cancel']],
      ['POST', [...list, ID, 'approve']],
      ['GET', [...list, ID, 'cancel']],
      ['POST', ['catalog', 'seller', 'offers', ID, 'shelf']],
      ['PUT', ['catalog', 'seller', 'offers', 'x', 'shelf']],
      ['PUT', ['catalog', 'seller', 'offers', ID, 'shelf', 'x']],
    ] as const) {
      expect((await send(method, [...path])).status, `${method} ${path.join('/')}`).toBe(404);
    }
  });
});
