import { describe, expect, it, vi } from 'vitest';
import { relay, upstreamHeaders } from './bff.ts';
import type { PanelConfig } from './config.ts';

const config: PanelConfig = {
  apiBaseUrl: 'http://api.test',
  hosts: [{ origin: 'http://admin.localhost:3002', host: 'admin.localhost:3002', marketId: 'AU' }],
  passwordMinLength: 15,
  passwordMaxLength: 128,
  marketName: 'Australia',
  locale: 'en-AU',
  supportEmail: 'support@example.com',
  clientAddressKey: null,
};

const sameOrigin = {
  host: 'admin.localhost:3002',
  origin: 'http://admin.localhost:3002',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};

function post(path: string, headers: Record<string, string> = sameOrigin, body = '{}') {
  return new Request(`http://admin.localhost:3002/api/${path}`, { method: 'POST', headers, body });
}

const upstreamOk = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"code":"signed-in"}', { status: 200 })));

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
        'identity/admin/sign-in',
        { ...sameOrigin, cookie: 'secret=1' },
        '{"password":"hunter2"}',
      ),
      ['identity', 'admin', 'sign-in'],
      () => Promise.resolve(upstream),
      log,
    );
    expect(log).toHaveBeenCalledWith({
      msg: 'panel.relay.error-answer',
      method: 'POST',
      path: 'identity/admin/sign-in',
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
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.reject(new Error('down')),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'panel.relay.upstream-unreachable' }),
    );
    const quiet = vi.fn();
    await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.resolve(new Response('{}', { status: 200 })),
      quiet,
    );
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe('relay', () => {
  it('answers 404 for a host that is not listed', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', { ...sameOrigin, host: 'evil.test' }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 404 for a path outside the allowlist', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/seller/sign-in'),
      ['identity', 'seller', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
  ])('relays the anonymous password routes (%s)', async (path) => {
    const response = await relay(config, post(path), path.split('/'), upstreamOk());
    expect(response.status).toBe(200);
  });

  it.each([
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
  ])('refuses a cross-site POST to %s', async (path) => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post(path, { ...sameOrigin, 'sec-fetch-site': 'cross-site' }),
      path.split('/'),
      fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('relays the id paths of the team commands, and only with a UUID id', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    const ok = upstreamOk();
    const allowed = await relay(
      config,
      post(`identity/admin/accounts/${id}/disable`),
      ['identity', 'admin', 'accounts', id, 'disable'],
      ok,
    );
    expect(allowed.status).toBe(200);
    for (const path of [
      ['identity', 'admin', 'accounts', 'not-a-uuid', 'disable'],
      ['identity', 'admin', 'accounts', id, 'password'],
      ['identity', 'admin', 'accounts', id, 'disable', 'extra'],
      ['identity', 'admin', 'sessions', id, 'disable'],
      ['identity', 'admin', 'accounts', `${id}%2F..`, 'disable'],
      ['identity', 'admin', 'accounts', '..', 'disable'],
      ['identity', 'admin', 'accounts', id, 'disable', ''],
    ]) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, post(path.join('/')), path, fetchImpl);
      expect(response.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('relays the customer commands and the owner two-step reset, and only with a UUID id', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    for (const path of [
      ['identity', 'admin', 'customers', 'lookup'],
      ['identity', 'admin', 'customers', id, 'disable'],
      ['identity', 'admin', 'customers', id, 'enable'],
      ['identity', 'admin', 'sellers', id, 'second-factor', 'reset'],
    ]) {
      const ok = upstreamOk();
      expect((await relay(config, post(path.join('/')), path, ok)).status).toBe(200);
    }
    for (const path of [
      ['identity', 'admin', 'customers'],
      ['identity', 'admin', 'customers', 'not-a-uuid', 'disable'],
      ['identity', 'admin', 'customers', id],
      ['identity', 'admin', 'customers', 'lookup', 'extra'],
      ['identity', 'admin', 'customers', id, 'disable', 'extra'],
      ['identity', 'admin', 'sellers', 'not-a-uuid', 'second-factor', 'reset'],
      ['identity', 'admin', 'sellers', id, 'second-factor'],
    ]) {
      const fetchImpl = upstreamOk();
      expect((await relay(config, post(path.join('/')), path, fetchImpl)).status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('relays change-role and invite, and refuses near misses and cross-site posts', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    for (const path of [
      ['identity', 'admin', 'accounts', id, 'role'],
      ['identity', 'admin', 'invitations'],
    ]) {
      const ok = upstreamOk();
      expect((await relay(config, post(path.join('/')), path, ok)).status).toBe(200);
      const blocked = upstreamOk();
      const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
      const response = await relay(config, post(path.join('/'), crossSite), path, blocked);
      expect(response.status).toBe(403);
      expect(blocked).not.toHaveBeenCalled();
    }
    for (const path of [
      ['identity', 'admin', 'invitations', id],
      ['identity', 'admin', 'invitations', 'x'],
      ['identity', 'admin', 'accounts', 'not-a-uuid', 'role'],
      ['identity', 'admin', 'accounts', id, 'role', 'extra'],
      ['identity', 'admin', 'accounts', `${id}%2F..`, 'role'],
    ]) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, post(path.join('/')), path, fetchImpl);
      expect(response.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses an unsafe request that is not same-origin', async () => {
    const fetchImpl = upstreamOk();
    const crossSite = { ...sameOrigin, 'sec-fetch-site': 'cross-site' };
    expect(
      (
        await relay(
          config,
          post('identity/admin/sign-in', crossSite),
          ['identity', 'admin', 'sign-in'],
          fetchImpl,
        )
      ).status,
    ).toBe(403);
    const otherOrigin = { ...sameOrigin, origin: 'http://evil.test' };
    expect(
      (
        await relay(
          config,
          post('identity/admin/sign-in', otherOrigin),
          ['identity', 'admin', 'sign-in'],
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
      post('identity/admin/sign-in', { ...sameOrigin, authorization: 'Bearer x' }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('role delete carries its version in the body', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    const path = ['identity', 'admin', 'roles', id];
    const del = (headers: Record<string, string>, body: string) =>
      new Request(`http://admin.localhost:3002/api/${path.join('/')}`, {
        method: 'DELETE',
        headers,
        body,
      });

    it('forwards the JSON body and its content type', async () => {
      const fetchImpl = upstreamOk();
      const response = await relay(
        config,
        del(sameOrigin, '{"expectedVersion":1}'),
        path,
        fetchImpl,
      );
      expect(response.status).toBe(200);
      const init = fetchImpl.mock.calls[0]?.[1];
      expect(init?.method).toBe('DELETE');
      expect(init?.body).toBe('{"expectedVersion":1}');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    });

    it('refuses a cross-site delete without calling the API', async () => {
      const fetchImpl = upstreamOk();
      const response = await relay(
        config,
        del({ ...sameOrigin, 'sec-fetch-site': 'cross-site' }, '{"expectedVersion":1}'),
        path,
        fetchImpl,
      );
      expect(response.status).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a delete body over 16 KB', async () => {
      const fetchImpl = upstreamOk();
      const response = await relay(
        config,
        del(sameOrigin, 'x'.repeat(16 * 1024 + 1)),
        path,
        fetchImpl,
      );
      expect(response.status).toBe(413);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('refuses a body over 16 KB', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', sameOrigin, 'x'.repeat(16 * 1024 + 1)),
      ['identity', 'admin', 'sign-in'],
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
    const request = new Request('http://admin.localhost:3002/api/identity/admin/sign-in', {
      method: 'POST',
      headers: sameOrigin,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = await relay(config, request, ['identity', 'admin', 'sign-in'], fetchImpl);
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses at once when Content-Length is over the cap', async () => {
    const fetchImpl = upstreamOk();
    const response = await relay(
      config,
      post('identity/admin/sign-in', { ...sameOrigin, 'content-length': '99999' }),
      ['identity', 'admin', 'sign-in'],
      fetchImpl,
    );
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends only allowlisted headers and the Market of the host', async () => {
    const fetchImpl = upstreamOk();
    await relay(
      config,
      post('identity/admin/sign-in', {
        ...sameOrigin,
        cookie: 'a=b',
        'x-market-id': 'NZ',
        'x-forwarded-for': '1.2.3.4',
        'x-csrf-token': 't',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0',
      }),
      ['identity', 'admin', 'sign-in'],
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
    upstream.headers.append('set-cookie', '__Host-session-admin-AU=abc; Path=/; Secure; HttpOnly');
    upstream.headers.append('set-cookie', 'other=1; Path=/');
    const response = await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      () => Promise.resolve(upstream),
    );
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 503 when the API is unreachable', async () => {
    const response = await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
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
    const request = new Request('http://admin.localhost:3002/', {
      headers: { 'x-mp-client-address': '203.0.113.7', 'x-client-address': 'forged' },
    });
    expect(upstreamHeaders(request, host, config, at).has('x-client-address')).toBe(false);
  });

  it('signs the address set by the panel server and overwrites a browser-sent header', () => {
    const request = new Request('http://admin.localhost:3002/', {
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
      post('identity/admin/sign-in', { ...sameOrigin, 'x-client-address': 'forged' }),
      ['identity', 'admin', 'sign-in'],
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
      post('identity/admin/sign-in', { ...sameOrigin, 'x-mp-client-address': '203.0.113.7' }),
      ['identity', 'admin', 'sign-in'],
      upstream,
      vi.fn(),
    );
    expect(response.status).toBe(200);
    // The vectors fix t, so only the shape is checked here; the signature has its own vectors.
    const sent = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(sent.get('x-client-address')).toMatch(/^v1;k=panel;t=\d+;a=203\.0\.113\.7;s=/);
  });

  it('relays the role editor routes, with a UUID id for edit and delete only', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    const request = (method: string, path: string) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        ...(method === 'DELETE' ? {} : { body: '{}' }),
      });
    for (const [method, path] of [
      ['POST', 'identity/admin/roles'],
      ['PUT', `identity/admin/roles/${id}`],
      ['DELETE', `identity/admin/roles/${id}`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
    }
    for (const [method, path] of [
      ['PUT', 'identity/admin/roles'],
      ['DELETE', 'identity/admin/roles'],
      ['DELETE', 'identity/admin/roles/not-a-uuid'],
      ['POST', `identity/admin/roles/${id}`],
      ['PUT', `identity/admin/roles/${id}/extra`],
    ] as const) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, request(method, path), path.split('/'), fetchImpl);
      expect(response.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('relays the seller list read, a POST only, and refuses it cross-site', async () => {
    const ok = upstreamOk();
    expect(
      (await relay(config, post('sellers/admin/list'), ['sellers', 'admin', 'list'], ok)).status,
    ).toBe(200);
    const getList = new Request('http://admin.localhost:3002/api/sellers/admin/list', {
      method: 'GET',
      headers: sameOrigin,
    });
    const fetchImpl = upstreamOk();
    expect((await relay(config, getList, ['sellers', 'admin', 'list'], fetchImpl)).status).toBe(
      404,
    );
    const crossSite = post('sellers/admin/list', { ...sameOrigin, 'sec-fetch-site': 'cross-site' });
    expect((await relay(config, crossSite, ['sellers', 'admin', 'list'], fetchImpl)).status).toBe(
      403,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('relay allowlist for seller decisions', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const call = (method: string, path: string) =>
    relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        body: '{}',
      }),
      path.split('/'),
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

  it('relays the support email read and write on their exact path and method only', async () => {
    const path = 'notifications/admin/support-contact';
    const read = new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, path.split('/'), fetchImpl)).status).toBe(200);
    const extra = new Request(`http://admin.localhost:3002/api/${path}/x`, { headers: sameOrigin });
    expect((await relay(config, extra, [...path.split('/'), 'x'], fetchImpl)).status).toBe(404);
    expect((await call('PUT', path)).status).toBe(200);
    expect((await call('POST', path)).status).toBe(404);
    expect((await call('DELETE', path)).status).toBe(404);
    expect((await call('PUT', `${path}/extra`)).status).toBe(404);
  });

  it('relays the assistant settings read and write on their exact path only', async () => {
    const path = 'assistant/admin/settings';
    const read = new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, path.split('/'), fetchImpl)).status).toBe(200);
    expect((await call('PUT', path)).status).toBe(200);
    expect((await call('POST', path)).status).toBe(404);
    expect((await call('DELETE', path)).status).toBe(404);
    expect((await call('PUT', `${path}/extra`)).status).toBe(404);
  });

  it('relays the own display name (PUT) and password change (POST) on their exact paths only', async () => {
    const name = 'identity/admin/profile/display-name';
    expect((await call('PUT', name)).status).toBe(200);
    expect((await call('POST', name)).status).toBe(404);
    expect((await call('PUT', `${name}/extra`)).status).toBe(404);
    const password = 'identity/admin/change-password';
    expect((await call('POST', password)).status).toBe(200);
    expect((await call('PUT', password)).status).toBe(404);
  });

  it('relays the own authenticator replacement (POST) on its two exact paths only', async () => {
    for (const path of [
      'identity/admin/second-factor/replacement',
      'identity/admin/second-factor/replacement/confirm',
    ]) {
      expect((await call('POST', path)).status, path).toBe(200);
      expect((await call('PUT', path)).status, path).toBe(404);
      expect((await call('DELETE', path)).status, path).toBe(404);
      expect((await call('POST', `${path}/extra`)).status, path).toBe(404);
    }
    // Recovery codes are not part of this page.
    expect((await call('POST', 'identity/admin/second-factor/recovery-codes')).status).toBe(404);
  });

  it('no longer relays the retired flat delivery fee route', async () => {
    expect((await call('PUT', `shipping/admin/sellers/${ID}/flat-fee`)).status).toBe(404);
    expect((await call('PUT', `shipping/admin/sellers/${ID}/delivery-methods`)).status).toBe(200);
  });

  it('relays the fleet-selection routes on their exact paths and methods only', async () => {
    const base = 'shipping/admin/fleet-selection';
    const read = new Request(`http://admin.localhost:3002/api/${base}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, base.split('/'), fetchImpl)).status).toBe(200);
    expect((await call('POST', `${base}/models`)).status).toBe(200);
    expect((await call('PUT', `${base}/models/${ID}`)).status).toBe(200);
    expect((await call('PUT', `${base}/models/nope`)).status).toBe(404);
    // The page is saved in one batch; the per-method and per-fleet routes are gone.
    expect((await call('PUT', base)).status).toBe(200);
    expect((await call('PUT', `${base}/active/same_day`)).status).toBe(404);
    expect((await call('PUT', `${base}/fleets/zoom2u/reliability`)).status).toBe(404);
    expect((await call('DELETE', `${base}/models/${ID}`)).status).toBe(404);
    expect((await call('PUT', `${base}/models`)).status).toBe(404);
  });

  it('relays the delivery settings of the Market and of a seller on their exact paths only', async () => {
    const base = 'shipping/admin/delivery-settings';
    const read = new Request(`http://admin.localhost:3002/api/${base}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, base.split('/'), fetchImpl)).status).toBe(200);
    expect((await call('PUT', base)).status).toBe(200);
    expect((await call('POST', base)).status).toBe(404);
    expect((await call('DELETE', base)).status).toBe(404);
    expect((await call('PUT', `${base}/extra`)).status).toBe(404);
    expect((await call('PUT', `shipping/admin/sellers/${ID}/delivery-methods`)).status).toBe(200);
    const readSeller = new Request(
      `http://admin.localhost:3002/api/shipping/admin/sellers/${ID}/delivery-methods`,
      { headers: sameOrigin },
    );
    expect(
      (
        await relay(
          config,
          readSeller,
          ['shipping', 'admin', 'sellers', ID, 'delivery-methods'],
          fetchImpl,
        )
      ).status,
    ).toBe(200);
    expect((await call('PUT', 'shipping/admin/sellers/nope/delivery-methods')).status).toBe(404);
    expect((await call('POST', `shipping/admin/sellers/${ID}/delivery-methods`)).status).toBe(404);
    expect((await call('DELETE', `shipping/admin/sellers/${ID}/delivery-methods`)).status).toBe(
      404,
    );
  });

  it('relays the commission rate for a seller UUID (GET, PUT, DELETE) and the ledger (GET)', async () => {
    const send = (method: string, path: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}`, {
          method,
          headers: method === 'GET' ? { host: 'admin.localhost:3002' } : sameOrigin,
          ...(method === 'PUT' ? { body: '{}' } : {}),
        }),
        path.split('/'),
        vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 }))),
      );
    const rate = `commission-payouts/admin/sellers/${ID}/commission-rate`;
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await send(method, rate)).status).toBe(200);
    }
    expect((await send('POST', rate)).status).toBe(404);
    expect(
      (await send('GET', 'commission-payouts/admin/sellers/nope/commission-rate')).status,
    ).toBe(404);
    const ledger = `commission-payouts/admin/sellers/${ID}/ledger`;
    expect((await send('GET', ledger)).status).toBe(200);
    expect((await send('PUT', ledger)).status).toBe(404);
    expect((await send('DELETE', ledger)).status).toBe(404);
  });

  it('forwards only limit and cursor of the ledger query', async () => {
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const path = `commission-payouts/admin/sellers/${ID}/ledger`;
    await relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}?limit=20&cursor=c1&x=1`, {
        method: 'GET',
        headers: { host: 'admin.localhost:3002' },
      }),
      path.split('/'),
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}?limit=20&cursor=c1`);
  });

  it('relays approve, reject and the manual check for a seller UUID only', async () => {
    expect((await call('POST', `sellers/admin/${ID}/review/approve`)).status).toBe(200);
    expect((await call('POST', `sellers/admin/${ID}/review/reject`)).status).toBe(200);
    expect((await call('PUT', `sellers/admin/${ID}/review/manual-register-check`)).status).toBe(
      200,
    );
    expect((await call('POST', 'sellers/admin/nope/review/approve')).status).toBe(404);
    expect((await call('PUT', `sellers/admin/${ID}/review/approve`)).status).toBe(404);
    expect((await call('POST', `sellers/admin/${ID}/review/suspend`)).status).toBe(404);
  });

  it('relays approve and reject of a held price for a UUID only, and no other method', async () => {
    expect((await call('POST', `pricing/admin/price-holds/${ID}/approve`)).status).toBe(200);
    expect((await call('POST', `pricing/admin/price-holds/${ID}/reject`)).status).toBe(200);
    expect((await call('POST', 'pricing/admin/price-holds/nope/approve')).status).toBe(404);
    expect((await call('PUT', `pricing/admin/price-holds/${ID}/approve`)).status).toBe(404);
    expect((await call('POST', `pricing/admin/price-holds/${ID}/delete`)).status).toBe(404);
  });
  it('relays the offer decisions by UUID, POST only', async () => {
    const id = '0190a000-0000-7000-8000-0000000000c1';
    const request = (method: string, path: string) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        body: '{}',
      });
    for (const action of ['approve', 'request-changes']) {
      const path = `catalog/admin/offers/${id}/${action}`;
      expect(
        (await relay(config, request('POST', path), path.split('/'), upstreamOk())).status,
      ).toBe(200);
    }
    for (const [method, path] of [
      ['PUT', `catalog/admin/offers/${id}/approve`],
      ['POST', 'catalog/admin/offers/nope/approve'],
      ['POST', `catalog/admin/offers/${id}/delete`],
      ['POST', 'catalog/admin/review-queue'],
    ] as const) {
      const fetchImpl = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), fetchImpl)).status).toBe(
        404,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('relay of the connected accounts list', () => {
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/payments/admin/connected-accounts${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['payments', 'admin', 'connected-accounts'];

  it('forwards only the status and cursor keys of the query', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get('?status=pending&cursor=abc&limit=500&x=1'),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/payments/admin/connected-accounts?status=pending&cursor=abc',
    );
  });

  it('forwards no query when none is given, and refuses other paths and methods', async () => {
    const upstream = upstreamOk();
    await relay(config, get(''), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/payments/admin/connected-accounts');
    const other = ['payments', 'admin', 'connected-accounts', 'x'];
    expect((await relay(config, get(''), other, upstream)).status).toBe(404);
    expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
  });
});

describe('relay of the orders list', () => {
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/orders${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['ordering', 'admin', 'orders'];

  it('forwards only the status and cursor keys of the query', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get('?status=confirmed&cursor=abc&limit=500&x=1'),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/ordering/admin/orders?status=confirmed&cursor=abc',
    );
  });

  it('refuses other paths and methods', async () => {
    const upstream = upstreamOk();
    const other = ['ordering', 'admin', 'orders', '0190a000-0000-7000-8000-000000000001'];
    expect((await relay(config, get(''), other, upstream)).status).toBe(404);
    expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the sellers without an owner', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/identity/admin/sellers${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['identity', 'admin', 'sellers'];

  it('forwards only the state, limit and after keys of the list query', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(`?state=orphaned&limit=25&after=${id}&email=a%40b.example`),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/identity/admin/sellers?state=orphaned&limit=25&after=${id}`,
    );
  });

  it('relays the owner invitation of one seller, only with a UUID id', async () => {
    const upstream = upstreamOk();
    const ok = await relay(
      config,
      post(`identity/admin/sellers/${id}/invitations`),
      ['identity', 'admin', 'sellers', id, 'invitations'],
      upstream,
    );
    expect(ok.status).toBe(200);
    for (const other of [
      ['identity', 'admin', 'sellers', 'not-a-uuid', 'invitations'],
      ['identity', 'admin', 'sellers', id, 'invitations', 'extra'],
      ['identity', 'admin', 'sellers', id, 'suspend'],
    ]) {
      expect((await relay(config, post(other.join('/')), other, upstream)).status).toBe(404);
    }
    expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(404);
  });
});

describe('relay of the admin notice routes', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const notices = ['notifications', 'admin', 'notices'];
  const get = (path: readonly string[], query = '') =>
    new Request(`http://admin.localhost:3002/api/${path.join('/')}${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });

  it('lists notices forwarding only a valid `show` and `before`, and reads the count', async () => {
    const upstream = upstreamOk();
    const query = `?show=read&before=${ID}&x=1`;
    expect((await relay(config, get(notices, query), notices, upstream)).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/notifications/admin/notices?show=read&before=${ID}`,
    );
    await relay(config, get(notices, '?show=everything&before=x'), notices, upstream);
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/notifications/admin/notices');
    const count = [...notices, 'unread-count'];
    expect((await relay(config, get(count, '?show=all'), count, upstream)).status).toBe(200);
    expect(upstream.mock.calls[2]?.[0]).toBe(
      'http://api.test/notifications/admin/notices/unread-count',
    );
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
    const read = [...notices, ID, 'read'];
    expect((await relay(config, get(read), read, upstream)).status).toBe(404);
  });
});

describe('relay of the storefront slides', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const request = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
  const list = ['storefront', 'admin', 'slides'];

  it('reads the list with only the state and position keys of the query', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      request('GET', 'storefront/admin/slides?state=live&position=home.hero&limit=5&x=1', {
        host: 'admin.localhost:3002',
      }),
      list,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/storefront/admin/slides?state=live&position=home.hero',
    );
  });

  it('drops a state or position of another shape', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      request('GET', 'storefront/admin/slides?state=live%27--&position=../x', {
        host: 'admin.localhost:3002',
      }),
      list,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/storefront/admin/slides');
  });

  it('creates a slide with a POST and replaces its draft with a PUT on a UUID', async () => {
    for (const [method, path] of [
      ['POST', 'storefront/admin/slides'],
      ['PUT', `storefront/admin/slides/${id}`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
    }
  });

  it('saves the order of a position with a PUT on the fixed order path, not as a slide id', async () => {
    const path = 'storefront/admin/slides/order';
    const upstream = upstreamOk();
    expect((await relay(config, request('PUT', path), path.split('/'), upstream)).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/storefront/admin/slides/order');
    expect(upstream.mock.calls[0]?.[1]?.method).toBe('PUT');
    for (const [method, other] of [
      ['POST', path],
      ['DELETE', path],
      ['PUT', `${path}/extra`],
      ['PUT', 'storefront/admin/slides/Order'],
      ['PUT', 'storefront/admin/slides/order%2F..'],
    ] as const) {
      const refused = upstreamOk();
      const response = await relay(config, request(method, other), other.split('/'), refused);
      expect(response.status, `${method} ${other}`).toBe(404);
      expect(refused).not.toHaveBeenCalled();
    }
  });

  it('sends each approval, pause, resume, archive and restore command as a POST on a UUID', async () => {
    for (const action of ['submit', 'approve', 'pause', 'resume', 'archive', 'restore']) {
      const path = `storefront/admin/slides/${id}/${action}`;
      const upstream = upstreamOk();
      expect((await relay(config, request('POST', path), path.split('/'), upstream)).status).toBe(
        200,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
      expect(upstream.mock.calls[0]?.[1]?.method).toBe('POST');
    }
  });

  it('reads the copy package of a slide with a GET, with no query crossing', async () => {
    const path = `storefront/admin/slides/${id}/copy`;
    const upstream = upstreamOk();
    const response = await relay(
      config,
      request('GET', `${path}?market=NZ`, { host: 'admin.localhost:3002' }),
      path.split('/'),
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
  });

  it('refuses a command from another site before it reaches the API', async () => {
    const cross = { ...sameOrigin, origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' };
    for (const action of ['submit', 'approve', 'pause', 'resume', 'archive', 'restore']) {
      const path = `storefront/admin/slides/${id}/${action}`;
      const upstream = upstreamOk();
      const response = await relay(config, request('POST', path, cross), path.split('/'), upstream);
      expect(response.status, action).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    }
  });

  it('reads the saved order of a position with a GET on the fixed order path and its three query keys', async () => {
    const path = ['storefront', 'admin', 'slides', 'order'];
    const category = '0190a000-0000-7000-8000-0000000000c1';
    const upstream = upstreamOk();
    const response = await relay(
      config,
      request(
        'GET',
        `storefront/admin/slides/order?position=category.top&scope=category&scopeId=${category}&state=live&x=1`,
        { host: 'admin.localhost:3002' },
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/storefront/admin/slides/order?position=category.top&scope=category&scopeId=${category}`,
    );
    expect(upstream.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('drops an order query value of another shape, and sends no query for none', async () => {
    const path = ['storefront', 'admin', 'slides', 'order'];
    const upstream = upstreamOk();
    await relay(
      config,
      request(
        'GET',
        'storefront/admin/slides/order?position=../x&scope=everything&scopeId=not-a-uuid',
        { host: 'admin.localhost:3002' },
      ),
      path,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/storefront/admin/slides/order');
  });

  it('never reads order as a slide id, and keeps the order read to its own path', async () => {
    for (const other of [
      'storefront/admin/slides/order/extra',
      'storefront/admin/slides/Order',
      'storefront/admin/slides/order%2F..',
    ]) {
      const refused = upstreamOk();
      const response = await relay(
        config,
        request('GET', other, { host: 'admin.localhost:3002' }),
        other.split('/'),
        refused,
      );
      expect(response.status, other).toBe(404);
      expect(refused).not.toHaveBeenCalled();
    }
  });

  it('refuses a write from another site, and every other slide route', async () => {
    const cross = { ...sameOrigin, origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' };
    const blocked = upstreamOk();
    const crossResponse = await relay(
      config,
      request('POST', 'storefront/admin/slides', cross),
      list,
      blocked,
    );
    expect(crossResponse.status).toBeGreaterThanOrEqual(400);
    expect(blocked).not.toHaveBeenCalled();
    const crossOrder = await relay(
      config,
      request('PUT', 'storefront/admin/slides/order', cross),
      ['storefront', 'admin', 'slides', 'order'],
      blocked,
    );
    expect(crossOrder.status).toBeGreaterThanOrEqual(400);
    expect(blocked).not.toHaveBeenCalled();
    for (const [method, path] of [
      ['PUT', 'storefront/admin/slides'],
      ['PUT', 'storefront/admin/slides/not-a-uuid'],
      ['POST', `storefront/admin/slides/${id}`],
      ['POST', `storefront/admin/slides/${id}/publish`],
      ['POST', `storefront/admin/slides/not-a-uuid/pause`],
      ['GET', `storefront/admin/slides/${id}/approve`],
      ['PUT', `storefront/admin/slides/${id}/pause`],
      ['DELETE', `storefront/admin/slides/${id}`],
      ['GET', `storefront/admin/slides/${id}`],
    ] as const) {
      const upstream = upstreamOk();
      const response = await relay(config, request(method, path), path.split('/'), upstream);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    }
  });
});

describe('relay of the wallet and step-up routes', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const request = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
  const readHeaders = { host: 'admin.localhost:3002' };
  const run = (method: string, path: string, headers?: Record<string, string>) => {
    const upstream = upstreamOk();
    const url = path.split('?')[0] ?? path;
    return relay(config, request(method, path, headers), url.split('/'), upstream).then(
      (response) => ({ response, upstream }),
    );
  };

  it.each([
    ['GET', 'wallet/admin/settings'],
    ['PUT', 'wallet/admin/settings'],
    ['GET', 'wallet/admin/credit-requests'],
    ['POST', 'wallet/admin/credits'],
    ['POST', 'identity/admin/step-up/verify'],
    ['GET', `wallet/admin/customers/${id}`],
    ['POST', `wallet/admin/credit-requests/${id}/approve`],
    ['POST', `wallet/admin/credit-requests/${id}/reject`],
    ['GET', 'customers/admin/account-deletion-settings'],
    ['PUT', 'customers/admin/account-deletion-settings'],
    ['GET', 'customers/admin/deletion-requests'],
    ['POST', `customers/admin/buyers/${id}/deletion-requests`],
    ['DELETE', `customers/admin/deletion-requests/${id}`],
    ['GET', 'catalog/admin/brands'],
    ['GET', 'catalog/admin/brands/merge-queue'],
    ['POST', 'catalog/admin/brands'],
    ['PUT', `catalog/admin/brands/${id}`],
    ['POST', `catalog/admin/brands/${id}/approve`],
    ['POST', `catalog/admin/brands/${id}/archive`],
    ['POST', `catalog/admin/brands/${id}/merge`],
    ['POST', 'catalog/admin/brands/merge-queue/dismiss'],
  ])('relays %s %s', async (method, path) => {
    const { response, upstream } = await run(
      method,
      path,
      method === 'GET' ? readHeaders : undefined,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
  });

  it.each([
    ['DELETE', 'wallet/admin/settings'],
    ['POST', 'wallet/admin/settings'],
    ['PUT', 'wallet/admin/credits'],
    ['GET', 'wallet/admin/credits'],
    ['GET', 'identity/admin/step-up/verify'],
    ['POST', 'wallet/admin/credit-requests'],
    ['GET', 'wallet/admin/customers'],
    ['GET', 'wallet/admin/customers/not-a-uuid'],
    ['POST', 'wallet/admin/credit-requests/not-a-uuid/approve'],
    ['POST', `wallet/admin/credit-requests/${id}/delete`],
    ['GET', `wallet/admin/customers/${id}/extra`],
    ['GET', 'wallet/me'],
    ['DELETE', 'customers/admin/account-deletion-settings'],
    ['POST', 'customers/admin/account-deletion-settings'],
    ['POST', 'customers/admin/deletion-requests'],
    ['GET', `customers/admin/deletion-requests/${id}`],
    ['POST', 'customers/admin/buyers/not-a-uuid/deletion-requests'],
    ['DELETE', 'customers/admin/deletion-requests/not-a-uuid'],
    ['DELETE', `catalog/admin/brands/${id}`],
    ['GET', `catalog/admin/brands/${id}`],
    ['PUT', 'catalog/admin/brands'],
    ['PUT', 'catalog/admin/brands/not-a-uuid'],
    ['POST', 'catalog/admin/brands/not-a-uuid/approve'],
    ['POST', `catalog/admin/brands/${id}/delete`],
    ['POST', 'catalog/admin/brands/merge-queue'],
    ['GET', 'catalog/admin/brands/merge-queue/dismiss'],
  ])('does not relay %s %s', async (method, path) => {
    const { response, upstream } = await run(
      method,
      path,
      method === 'GET' ? readHeaders : undefined,
    );
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes only limit and a well-formed cursor of the deletion request list', async () => {
    const { upstream } = await run(
      'GET',
      `customers/admin/deletion-requests?limit=50&cursor=1792000000000.${id}&status=executing&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/customers/admin/deletion-requests?cursor=1792000000000.${id}&limit=50`,
    );
    const bad = await run(
      'GET',
      'customers/admin/deletion-requests?cursor=nope&limit=abc',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/customers/admin/deletion-requests',
    );
  });

  it('passes only status, search, afterId and limit of the brand list, each in its shape', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/brands?status=draft&search=saffron&afterId=${id}&limit=25&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/brands?status=draft&search=saffron&afterId=${id}&limit=25`,
    );
    const bad = await run(
      'GET',
      'catalog/admin/brands?status=deleted&afterId=nope&limit=abc',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/brands');
  });

  it('refuses a cross-site POST to the step-up verify route and to the credit routes', async () => {
    for (const path of [
      'identity/admin/step-up/verify',
      'wallet/admin/credits',
      `wallet/admin/credit-requests/${id}/approve`,
    ]) {
      const { response, upstream } = await run('POST', path, {
        ...sameOrigin,
        'sec-fetch-site': 'cross-site',
        origin: 'http://evil.test',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'request.csrf' });
      expect(upstream).not.toHaveBeenCalled();
    }
    const { response } = await run('PUT', 'wallet/admin/settings', {
      ...sameOrigin,
      origin: 'http://evil.test',
    });
    expect(response.status).toBe(403);
  });

  it('passes only the status, cursor and limit of the requests list, in their shapes', async () => {
    const cursor = `1790000000000.${id}`;
    const { upstream } = await run(
      'GET',
      `wallet/admin/credit-requests?status=decided&limit=20&cursor=${cursor}&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/wallet/admin/credit-requests?status=decided&cursor=${encodeURIComponent(cursor)}&limit=20`,
    );
    const bad = await run(
      'GET',
      'wallet/admin/credit-requests?status=all&limit=1000&cursor=a%20b',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe('http://api.test/wallet/admin/credit-requests');
  });

  it('passes no query on the customer summary or the settings', async () => {
    const summary = await run('GET', `wallet/admin/customers/${id}?status=pending`, readHeaders);
    expect(summary.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/wallet/admin/customers/${id}`,
    );
    const settings = await run('GET', 'wallet/admin/settings?x=1', readHeaders);
    expect(settings.upstream.mock.calls[0]?.[0]).toBe('http://api.test/wallet/admin/settings');
  });

  it('passes a dispute list cursor only in the shape the API issues', async () => {
    const cursor = `1790000000000.${id}`;
    const ok = await run(
      'GET',
      `commission-payouts/admin/disputes?filter=closed&limit=20&cursor=${cursor}&x=1`,
      readHeaders,
    );
    expect(ok.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/disputes?filter=closed&cursor=${encodeURIComponent(cursor)}&limit=20`,
    );
    for (const bad of ['a%20b', "1790000000000.x'%20OR%201=1", `${id}`, '1.2.3', '..%2F..']) {
      const dropped = await run(
        'GET',
        `commission-payouts/admin/disputes?filter=closed&cursor=${bad}`,
        readHeaders,
      );
      expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
        'http://api.test/commission-payouts/admin/disputes?filter=closed',
      );
    }
  });

  it.each([
    ['GET', 'commission-payouts/admin/payouts'],
    ['GET', `commission-payouts/admin/payouts/${id}`],
    ['POST', `commission-payouts/admin/payouts/${id}/approve`],
    ['GET', `commission-payouts/admin/sellers/${id}/payout-terms`],
    ['PUT', `commission-payouts/admin/sellers/${id}/payout-terms`],
    ['GET', `commission-payouts/admin/sellers/${id}/payout-holds`],
    ['POST', `commission-payouts/admin/sellers/${id}/payout-holds`],
    ['POST', `commission-payouts/admin/payout-holds/${id}/release`],
  ])('relays the payout route %s %s', async (method, path) => {
    const { response, upstream } = await run(
      method,
      path,
      method === 'GET' ? readHeaders : undefined,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
  });

  it('passes a payout list query only in the shape the API issues', async () => {
    const cursor = `1790000000000.${id}`;
    const ok = await run(
      'GET',
      `commission-payouts/admin/payouts?status=awaiting-approval&limit=50&cursor=${cursor}&x=1`,
      readHeaders,
    );
    expect(ok.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/payouts?status=awaiting-approval&cursor=${encodeURIComponent(cursor)}&limit=50`,
    );
    const bad = await run(
      'GET',
      'commission-payouts/admin/payouts?status=all&limit=100000&cursor=a%20b',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/commission-payouts/admin/payouts',
    );
    // Only the states a tab shows cross; the API's other states are not relayed.
    for (const state of ['pending', 'voided', 'settled-by-netting']) {
      const other = await run(
        'GET',
        `commission-payouts/admin/payouts?status=${state}`,
        readHeaders,
      );
      expect(other.upstream.mock.calls[0]?.[0]).toBe(
        'http://api.test/commission-payouts/admin/payouts',
      );
    }
  });

  it('passes the version and reason of removing payout terms, and nothing else', async () => {
    const ok = await run(
      'DELETE',
      `commission-payouts/admin/sellers/${id}/payout-terms?expectedVersion=3&reasonCode=policy&x=1`,
    );
    expect(ok.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/sellers/${id}/payout-terms?expectedVersion=3&reasonCode=policy`,
    );
    const bad = await run(
      'DELETE',
      `commission-payouts/admin/sellers/${id}/payout-terms?expectedVersion=3.5&reasonCode=because`,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/sellers/${id}/payout-terms`,
    );
  });

  it('does not relay a payout write the panel has no screen for', async () => {
    for (const [method, path] of [
      ['DELETE', `commission-payouts/admin/payouts/${id}`],
      ['PUT', `commission-payouts/admin/payouts/${id}`],
      ['POST', `commission-payouts/admin/payouts/${id}/void`],
    ] as const) {
      const { response, upstream } = await run(method, path);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    }
  });
});
