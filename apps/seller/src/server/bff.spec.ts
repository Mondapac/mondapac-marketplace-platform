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
      }),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    const init = fetchImpl.mock.calls[0]![1]!;
    const sent = init.headers as Headers;
    expect(sent.get('x-market-id')).toBe('AU');
    expect(sent.get('cookie')).toBe('a=b');
    expect(sent.get('x-csrf-token')).toBe('t');
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

describe('relay allowlist for stock locations', () => {
  const put = (path: string) =>
    new Request(`http://seller.localhost:3001/api/${path}`, {
      method: 'PUT',
      headers: sameOrigin,
      body: '{}',
    });
  const ID = '0190a000-0000-7000-8000-0000000000a1';

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
