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

  it('sets nosniff on every answer itself, because the panel proxy does not run for /api/', async () => {
    const ok = await relay(
      config,
      post('identity/admin/sign-in'),
      ['identity', 'admin', 'sign-in'],
      upstreamOk(),
    );
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    const refused = await relay(
      config,
      post('identity/admin/sign-in', { ...sameOrigin, origin: 'http://evil.test' }),
      ['identity', 'admin', 'sign-in'],
      upstreamOk(),
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff');
    const unlisted = await relay(config, post('nothing/here'), ['nothing', 'here'], upstreamOk());
    expect(unlisted.status).toBe(404);
    expect(unlisted.headers.get('x-content-type-options')).toBe('nosniff');
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

  it('relays the category editor on its exact paths and methods only (categories C3)', async () => {
    const id = ID;
    const base = 'catalog/admin/categories';
    expect((await call('POST', base)).status).toBe(200);
    expect((await call('PATCH', `${base}/${id}`)).status).toBe(200);
    for (const action of ['reorder', 'hide', 'show', 'change-slug', 'discard']) {
      expect((await call('POST', `${base}/${id}/${action}`)).status).toBe(200);
      expect((await call('PUT', `${base}/${id}/${action}`)).status).toBe(404);
    }
    expect((await call('PUT', `${base}/${id}`)).status).toBe(404);
    expect((await call('DELETE', `${base}/${id}`)).status).toBe(404);
    expect((await call('POST', `${base}/${id}`)).status).toBe(404);
    expect((await call('PATCH', `${base}/not-a-uuid`)).status).toBe(404);
    expect((await call('POST', `${base}/${id}/restore`)).status).toBe(404);
  });

  it('relays move, merge and archive on their exact paths and methods only (categories C4a)', async () => {
    const id = ID;
    const base = 'catalog/admin/categories';
    for (const action of ['move', 'merge', 'archive']) {
      expect((await call('POST', `${base}/${id}/${action}`)).status).toBe(200);
      expect((await call('PUT', `${base}/${id}/${action}`)).status).toBe(404);
      expect((await call('PATCH', `${base}/${id}/${action}`)).status).toBe(404);
      expect((await call('DELETE', `${base}/${id}/${action}`)).status).toBe(404);
      expect((await call('POST', `${base}/not-a-uuid/${action}`)).status).toBe(404);
      expect((await call('POST', `${base}/${id}/${action}/extra`)).status).toBe(404);
    }
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

  it('relays the service areas: a read, and the name edit as a POST on its exact path', async () => {
    const base = 'sellers/admin/service-areas';
    const read = new Request(`http://admin.localhost:3002/api/${base}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, base.split('/'), fetchImpl)).status).toBe(200);
    expect((await call('POST', `${base}/names`)).status).toBe(200);
    expect((await call('POST', base)).status).toBe(404);
    expect((await call('PUT', `${base}/names`)).status).toBe(404);
    expect((await call('DELETE', `${base}/names`)).status).toBe(404);
    expect((await call('POST', `${base}/names/extra`)).status).toBe(404);
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

  it('relays the recalculate request of one seller, by POST only', async () => {
    const send = (method: string, path: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}`, {
          method,
          headers: method === 'GET' ? { host: 'admin.localhost:3002' } : sameOrigin,
          ...(method === 'POST' ? { body: '{}' } : {}),
        }),
        path.split('/'),
        vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 202 }))),
      );
    const recalculate = `sellers/admin/${ID}/health/recalculate`;
    expect((await send('POST', recalculate)).status).toBe(202);
    expect((await send('GET', recalculate)).status).toBe(404);
    expect((await send('POST', 'sellers/admin/nope/health/recalculate')).status).toBe(404);
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

  it('relays the category-proposals switch as PUT for a seller UUID only (C9-0)', async () => {
    expect((await call('PUT', `sellers/admin/${ID}/category-proposals`)).status).toBe(200);
    expect((await call('PUT', 'sellers/admin/nope/category-proposals')).status).toBe(404);
    expect((await call('POST', `sellers/admin/${ID}/category-proposals`)).status).toBe(404);
    expect((await call('DELETE', `sellers/admin/${ID}/category-proposals`)).status).toBe(404);
  });

  it('relays the Write with AI routes and the AI settings on their exact methods only (AIS-03)', async () => {
    const read = (path: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin }),
        path.split('/'),
        vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 }))),
      );
    const writer = 'catalog/admin/description-writer';
    expect((await read(writer)).status).toBe(200);
    expect((await read(`${writer}/model-setup`)).status).toBe(200);
    expect((await call('POST', `${writer}/drafts`)).status).toBe(200);
    expect((await call('PUT', `${writer}/drafts`)).status).toBe(404);
    expect((await call('PUT', `${writer}/model-setup`)).status).toBe(404);
    expect((await call('POST', `${writer}/model-setup`)).status).toBe(404);
    expect((await read('settings/admin/ai')).status).toBe(200);
    expect((await call('PUT', 'settings/admin/ai')).status).toBe(200);
    expect((await call('POST', 'settings/admin/ai')).status).toBe(404);
    expect((await call('DELETE', 'settings/admin/ai')).status).toBe(404);
    expect((await call('PUT', `sellers/admin/${ID}/ai-access`)).status).toBe(200);
    expect((await call('PUT', 'sellers/admin/nope/ai-access')).status).toBe(404);
    expect((await call('POST', `sellers/admin/${ID}/ai-access`)).status).toBe(404);
    expect((await read(`sellers/admin/${ID}/ai-access`)).status).toBe(404);
  });

  it('relays approve and reject of a held price for a UUID only, and no other method', async () => {
    expect((await call('POST', `pricing/admin/price-holds/${ID}/approve`)).status).toBe(200);
    expect((await call('POST', `pricing/admin/price-holds/${ID}/reject`)).status).toBe(200);
    expect((await call('POST', 'pricing/admin/price-holds/nope/approve')).status).toBe(404);
    expect((await call('PUT', `pricing/admin/price-holds/${ID}/approve`)).status).toBe(404);
    expect((await call('POST', `pricing/admin/price-holds/${ID}/delete`)).status).toBe(404);
  });
  it('relays add-sizes as a POST and its impact read as a GET, each on its own method only', async () => {
    const base = `catalog/admin/platform-products/${ID}`;
    const read = (path: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin }),
        path.split('/'),
        vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 }))),
      );
    expect((await call('POST', `${base}/add-sizes`)).status).toBe(200);
    expect((await read(`${base}/add-sizes`)).status).toBe(404);
    expect((await call('PUT', `${base}/add-sizes`)).status).toBe(404);
    expect((await read(`${base}/add-sizes-impact`)).status).toBe(200);
    expect((await call('POST', `${base}/add-sizes-impact`)).status).toBe(404);
    expect((await call('DELETE', `${base}/add-sizes-impact`)).status).toBe(404);
    expect((await call('POST', 'catalog/admin/platform-products/nope/add-sizes')).status).toBe(404);
    expect((await read('catalog/admin/platform-products/nope/add-sizes-impact')).status).toBe(404);
  });

  it('relays the product version decisions and the photo takedown by UUID, POST only', async () => {
    const id = '0190a000-0000-7000-8000-0000000000c1';
    const request = (method: string, path: string) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        body: '{}',
      });
    for (const path of [
      `catalog/admin/products/${id}/revisions/${id}/approve`,
      `catalog/admin/products/${id}/revisions/${id}/request-changes`,
      `catalog/admin/products/${id}/images/${id}/take-down`,
    ]) {
      expect(
        (await relay(config, request('POST', path), path.split('/'), upstreamOk())).status,
        path,
      ).toBe(200);
    }
    for (const [method, path] of [
      ['PUT', `catalog/admin/products/${id}/revisions/${id}/approve`],
      ['POST', `catalog/admin/products/nope/revisions/${id}/approve`],
      ['POST', `catalog/admin/products/${id}/revisions/nope/request-changes`],
      ['POST', `catalog/admin/products/${id}/revisions/${id}/delete`],
      ['DELETE', `catalog/admin/products/${id}/images/${id}/take-down`],
      ['POST', `catalog/admin/products/${id}/images/${id}`],
    ] as const) {
      const fetchImpl = upstreamOk();
      expect(
        (await relay(config, request(method, path), path.split('/'), fetchImpl)).status,
        `${method} ${path}`,
      ).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
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

  it('forwards the page mode and the filters', async () => {
    const upstream = upstreamOk();
    const q =
      'page=2&pageSize=25&sort=total&direction=desc&paymentState=paid&from=2026-10-01T00%3A00%3A00.000Z';
    await relay(config, get(`?${q}&x=1`), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/ordering/admin/orders?${q}`);
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

describe('relay of the blog editor', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const put = (path: string, body: string) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method: 'PUT',
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      body,
    });

  it('takes a draft of up to 60 KB, more than the usual 16 KB, and refuses more', async () => {
    const path = `blog/admin/posts/${id}/draft`;
    const upstream = upstreamOk();
    const ok = JSON.stringify({ content: { pad: 'x'.repeat(40 * 1024) } });
    expect((await relay(config, put(path, ok), path.split('/'), upstream)).status).toBe(200);
    const big = JSON.stringify({ content: { pad: 'x'.repeat(61 * 1024) } });
    expect((await relay(config, put(path, big), path.split('/'), upstream)).status).toBe(413);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps the usual 16 KB cap on the submit and create routes', async () => {
    const upstream = upstreamOk();
    const big = JSON.stringify({ pad: 'x'.repeat(17 * 1024) });
    for (const path of ['blog/admin/posts', `blog/admin/posts/${id}/submit`]) {
      const request = new Request(`http://admin.localhost:3002/api/${path}`, {
        method: 'POST',
        headers: { ...sameOrigin, 'content-type': 'application/json' },
        body: big,
      });
      expect((await relay(config, request, path.split('/'), upstream)).status).toBe(413);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the blog posts list', () => {
  const request = (path: string) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const list = ['blog', 'admin', 'posts'];

  it('passes the status, kind, owner and page of the query and nothing else', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      request('blog/admin/posts?status=in_review&kind=event&owner=seller&page=2&sellerId=x&x=1'),
      list,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/blog/admin/posts?status=in_review&kind=event&owner=seller&page=2',
    );
  });

  it('drops a value of another shape', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      request('blog/admin/posts?status=live%27--&kind=../x&owner=all&page=0x1'),
      list,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/blog/admin/posts');
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

  it('reads the page list and the template catalogue, and creates a page with a POST', async () => {
    for (const [method, path] of [
      ['GET', 'storefront/admin/pages'],
      ['GET', 'storefront/admin/catalogue'],
      ['POST', 'storefront/admin/pages'],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
    }
  });

  it('changes one page by its id or system key: settings, modules and their order', async () => {
    const slot = 'storefront/admin/pages';
    for (const [method, path] of [
      ['PUT', `${slot}/${id}`],
      ['PUT', `${slot}/home`],
      ['POST', `${slot}/${id}/slots/main/modules`],
      ['POST', `${slot}/offers/slots/top/modules`],
      ['PUT', `${slot}/${id}/slots/no-results/modules/${id}`],
      ['DELETE', `${slot}/${id}/slots/main/modules/${id}`],
      ['PUT', `${slot}/${id}/slots/main/order`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
      expect(ok.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
    }
  });

  it('keeps every other page shape closed', async () => {
    const base = 'storefront/admin/pages';
    for (const [method, path] of [
      // One page is read by the page server, and a page is never deleted or replaced as a list.
      ['GET', `${base}/${id}`],
      ['DELETE', `${base}/${id}`],
      ['PUT', base],
      ['POST', 'storefront/admin/catalogue'],
      // The navigation has its own routes; a word that is no system page is no page.
      ['PUT', `${base}/navigation`],
      ['PUT', `${base}/Home`],
      ['PUT', `${base}/nope`],
      ['PUT', `${base}/${id}/extra`],
      // A slot is a plain key and a module is a UUID.
      ['POST', `${base}/${id}/slots/Main/modules`],
      ['POST', `${base}/${id}/slots/main%2F..%2Fmodules/modules`],
      ['POST', `${base}/${id}/slots/${'a'.repeat(33)}/modules`],
      ['PUT', `${base}/${id}/slots/main/modules/not-an-id`],
      ['DELETE', `${base}/${id}/slots/main/modules/home`],
      ['PUT', `${base}/${id}/slots/main/modules`],
      ['POST', `${base}/${id}/slots/main/order`],
      ['DELETE', `${base}/${id}/slots/main/order`],
      // Publish, archive and restore come with their own screens.
      ['POST', `${base}/${id}/publish`],
      ['POST', `${base}/${id}/archive`],
      ['POST', `${base}/${id}/restore`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(404);
      expect(ok).not.toHaveBeenCalled();
    }
  });

  it('passes no query to the page list', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      request('GET', 'storefront/admin/pages?status=draft', { host: 'admin.localhost:3002' }),
      ['storefront', 'admin', 'pages'],
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/storefront/admin/pages');
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
    ['GET', 'promotions/admin/settings'],
    ['PUT', 'promotions/admin/settings'],
    ['GET', 'promotions/admin/first-order'],
    ['PUT', 'promotions/admin/first-order'],
    ['GET', 'promotions/admin/free-shipping'],
    ['PUT', 'promotions/admin/free-shipping/logan'],
    ['PUT', 'promotions/admin/free-shipping/Gold_Coast-2'],
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
    ['GET', 'blog/admin/posts'],
    ['POST', 'blog/admin/posts'],
    ['GET', `blog/admin/posts/${id}`],
    ['GET', `blog/admin/posts/${id}/checks`],
    ['PUT', `blog/admin/posts/${id}/draft`],
    ['PUT', `blog/admin/posts/${id}/event-status`],
    ['POST', `blog/admin/posts/${id}/submit`],
    ['POST', `blog/admin/posts/${id}/approve`],
    ['POST', `blog/admin/posts/${id}/request-changes`],
    ['GET', 'blog/admin/taxonomy'],
    ['GET', 'catalog/admin/brands'],
    ['GET', 'catalog/admin/brands/merge-queue'],
    ['POST', 'catalog/admin/brands'],
    ['PUT', `catalog/admin/brands/${id}`],
    ['POST', `catalog/admin/brands/${id}/approve`],
    ['POST', `catalog/admin/brands/${id}/archive`],
    ['POST', `catalog/admin/brands/${id}/merge`],
    ['POST', 'catalog/admin/brands/merge-queue/dismiss'],
    ['GET', 'catalog/admin/categories'],
    ['GET', `catalog/admin/categories/${id}`],
    ['GET', `catalog/admin/categories/${id}/impact`],
    ['GET', 'catalog/admin/business-activities'],
    ['GET', `catalog/admin/business-activities/${id}`],
    ['POST', 'catalog/admin/business-activities'],
    ['PUT', `catalog/admin/business-activities/${id}`],
    ['GET', 'catalog/admin/topics'],
    ['GET', `catalog/admin/topics/${id}`],
    ['POST', 'catalog/admin/topics'],
    ['PUT', `catalog/admin/topics/${id}`],
    ['GET', 'catalog/admin/attributes'],
    ['GET', `catalog/admin/attributes/${id}`],
    ['POST', 'catalog/admin/attributes'],
    ['PUT', `catalog/admin/attributes/${id}`],
    ['POST', `catalog/admin/attributes/${id}/publish`],
    ['POST', `catalog/admin/attributes/${id}/discard`],
    ['GET', 'catalog/admin/attribute-suggestions'],
    ['POST', `catalog/admin/attribute-suggestions/${id}/approve`],
    ['POST', `catalog/admin/attribute-suggestions/${id}/map`],
    ['POST', `catalog/admin/attribute-suggestions/${id}/reject`],
    ['GET', 'catalog/admin/variant-requests'],
    ['POST', `catalog/admin/variant-requests/${id}/approve`],
    ['POST', `catalog/admin/variant-requests/${id}/map`],
    ['POST', `catalog/admin/variant-requests/${id}/decline`],
    ['GET', 'catalog/admin/category-proposals'],
    ['POST', `catalog/admin/category-proposals/${id}/approve`],
    ['POST', `catalog/admin/category-proposals/${id}/reject`],
    ['GET', `catalog/admin/sellers/${id}/shelves`],
    ['POST', `catalog/admin/shelves/${id}/promote`],
    ['POST', `catalog/admin/shelves/${id}/merge`],
    ['GET', 'catalog/admin/topic-suggestions'],
    ['POST', `catalog/admin/topic-suggestions/${id}/approve`],
    ['POST', `catalog/admin/topic-suggestions/${id}/map`],
    ['POST', `catalog/admin/topic-suggestions/${id}/reject`],
    ['GET', 'catalog/admin/attribute-relaxations'],
    ['GET', 'catalog/admin/attribute-archive-requests'],
    ['GET', 'catalog/admin/reports/products-missing-details'],
    ['POST', 'catalog/admin/reports/products-missing-details/email-sellers'],
    ['POST', `catalog/admin/attributes/${id}/relaxation-requests`],
    ['POST', `catalog/admin/attribute-relaxations/${id}/confirm`],
    ['POST', `catalog/admin/attribute-relaxations/${id}/cancel`],
    ['GET', `catalog/admin/attributes/${id}/impact`],
    ['POST', `catalog/admin/attributes/${id}/merge-values`],
    ['POST', `catalog/admin/attributes/${id}/merge`],
    ['POST', `catalog/admin/attributes/${id}/convert`],
    ['POST', `catalog/admin/attributes/${id}/archive`],
    ['POST', `catalog/admin/attributes/${id}/archive-requests`],
    ['POST', `catalog/admin/attribute-archive-requests/${id}/confirm`],
    ['GET', 'catalog/admin/feature-sets'],
    ['GET', `catalog/admin/feature-sets/${id}`],
    ['PUT', `catalog/admin/feature-sets/${id}`],
    ['GET', `catalog/admin/categories/${id}/attribute-links`],
    ['PUT', `catalog/admin/categories/${id}/attribute-links`],
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
    ['POST', 'promotions/admin/settings'],
    ['DELETE', 'promotions/admin/first-order'],
    ['GET', 'promotions/admin/free-shipping/logan'],
    ['PUT', 'promotions/admin/free-shipping'],
    ['PUT', 'promotions/admin/free-shipping/a.b'],
    ['PUT', 'promotions/admin/free-shipping/logan/extra'],
    ['PUT', `promotions/admin/free-shipping/${'z'.repeat(65)}`],
    ['GET', 'promotions/admin/promotions'],
    ['PUT', 'promotions/admin/preview-quote'],
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
    ['PUT', `catalog/admin/categories/${id}`],
    ['DELETE', `catalog/admin/categories/${id}`],
    ['GET', 'catalog/admin/categories/not-a-uuid'],
    ['GET', `catalog/admin/categories/${id}/extra`],
    ['POST', `catalog/admin/categories/${id}/impact`],
    ['DELETE', `catalog/admin/business-activities/${id}`],
    ['PUT', 'catalog/admin/business-activities'],
    ['PUT', 'catalog/admin/business-activities/not-a-uuid'],
    ['POST', `catalog/admin/business-activities/${id}`],
    ['GET', 'catalog/admin/business-activities/not-a-uuid'],
    ['DELETE', `catalog/admin/topics/${id}`],
    ['PUT', 'catalog/admin/topics'],
    ['POST', `catalog/admin/topics/${id}`],
    ['GET', 'catalog/admin/topics/not-a-uuid'],
    ['PUT', 'catalog/admin/attributes'],
    ['POST', 'catalog/admin/category-proposals'],
    ['POST', `catalog/admin/category-proposals/${id}`],
    ['PUT', `catalog/admin/category-proposals/${id}/approve`],
    ['GET', `catalog/admin/category-proposals/${id}/approve`],
    ['DELETE', `catalog/admin/shelves/${id}/promote`],
    ['POST', `catalog/admin/shelves/${id}`],
    ['GET', `catalog/admin/shelves/${id}/merge`],
    ['POST', 'catalog/admin/shelves/not-a-uuid/promote'],
    ['POST', `catalog/admin/sellers/${id}/shelves`],
    ['GET', 'catalog/admin/sellers/not-a-uuid/shelves'],
    ['POST', 'catalog/admin/attribute-suggestions'],
    ['POST', `catalog/admin/attribute-suggestions/${id}`],
    ['PUT', `catalog/admin/attribute-suggestions/${id}/approve`],
    ['POST', 'catalog/admin/topic-suggestions'],
    ['PUT', `catalog/admin/topic-suggestions/${id}/approve`],
    ['PUT', 'catalog/admin/attributes/not-a-uuid'],
    ['POST', `catalog/admin/attributes/${id}`],
    ['DELETE', `catalog/admin/attributes/${id}`],
    ['POST', 'catalog/admin/attribute-relaxations'],
    ['GET', `catalog/admin/attribute-relaxations/${id}/confirm`],
    ['POST', 'catalog/admin/attribute-relaxations/not-a-uuid/cancel'],
    ['POST', 'catalog/admin/attributes/not-a-uuid/relaxation-requests'],
    ['POST', 'catalog/admin/attribute-relaxations/not-a-uuid/confirm'],
    ['POST', 'catalog/admin/attributes/not-a-uuid/merge-values'],
    ['POST', 'catalog/admin/attributes/not-a-uuid/merge'],
    ['POST', 'catalog/admin/attributes/not-a-uuid/convert'],
    ['POST', 'catalog/admin/attributes/not-a-uuid/archive'],
    ['POST', 'catalog/admin/attribute-archive-requests/not-a-uuid/confirm'],
    ['GET', `catalog/admin/attribute-archive-requests/${id}/confirm`],
    ['POST', `catalog/admin/attributes/${id}/impact`],
    ['GET', `catalog/admin/attributes/${id}/relaxation-requests`],
    ['POST', `catalog/admin/attribute-relaxations/${id}`],
    ['POST', 'catalog/admin/attributes/not-a-uuid/publish'],
    ['GET', `catalog/admin/attributes/${id}/archive`],
    ['GET', `catalog/admin/attributes/${id}/publish`],
    ['GET', 'catalog/admin/attributes/not-a-uuid'],
    ['POST', 'catalog/admin/feature-sets'],
    ['GET', 'catalog/admin/feature-sets/not-a-uuid'],
    ['PUT', 'catalog/admin/feature-sets/not-a-uuid'],
    ['PUT', 'catalog/admin/feature-sets'],
    ['DELETE', `catalog/admin/feature-sets/${id}`],
    ['POST', `catalog/admin/categories/${id}/attribute-links`],
    ['PUT', 'catalog/admin/categories/not-a-uuid/attribute-links'],
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

  it('passes only afterId and limit of the category proposal queue, each in its shape', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/category-proposals?afterId=${id}&limit=25&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/category-proposals?afterId=${id}&limit=25`,
    );
    const bad = await run(
      'GET',
      'catalog/admin/category-proposals?afterId=nope&limit=abc',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/category-proposals',
    );
  });

  it('passes only status, search, afterId and limit of the business activity list', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/business-activities?status=inactive&search=gro&afterId=${id}&limit=25&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/business-activities?status=inactive&search=gro&afterId=${id}&limit=25`,
    );
    const bad = await run(
      'GET',
      'catalog/admin/business-activities?status=draft&afterId=nope&limit=abc',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/business-activities',
    );
  });

  it('passes only status, group, search, afterId and limit of the tag list', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/topics?status=archived&group=cuisine&search=bbq&afterId=${id}&limit=25&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/topics?status=archived&group=cuisine&search=bbq&afterId=${id}&limit=25`,
    );
    const bad = await run(
      'GET',
      'catalog/admin/topics?status=inactive&group=season&afterId=nope&limit=abc',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/topics');
  });

  it('passes only the action of the category impact read, in its shape, and no query on the tree', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/categories/${id}/impact?action=merge&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/categories/${id}/impact?action=merge`,
    );
    const bad = await run(
      'GET',
      `catalog/admin/categories/${id}/impact?action=delete`,
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/categories/${id}/impact`,
    );
    const tree = await run('GET', 'catalog/admin/categories?q=x&limit=3', readHeaders);
    expect(tree.upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/categories');
  });

  it('passes only featureSetId of the category tree, and only as an id', async () => {
    const good = await run(
      'GET',
      `catalog/admin/categories?featureSetId=${id}&q=x&limit=3`,
      readHeaders,
    );
    expect(good.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/categories?featureSetId=${id}`,
    );
    for (const bad of ['nope', '', `${id}x`, "'; drop"]) {
      const { upstream } = await run(
        'GET',
        `catalog/admin/categories?featureSetId=${encodeURIComponent(bad)}`,
        readHeaders,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/categories');
    }
  });

  it('drops a target that is not exactly top or an id: TOP, Top and an empty one (categories C4b)', async () => {
    for (const bad of ['TOP', 'Top', '']) {
      const { upstream } = await run(
        'GET',
        `catalog/admin/categories/${id}/impact?action=move&targetId=${bad}`,
        readHeaders,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/catalog/admin/categories/${id}/impact?action=move`,
      );
    }
  });

  it('passes the target of the category impact read only as an id or top (categories C4b)', async () => {
    const withId = await run(
      'GET',
      `catalog/admin/categories/${id}/impact?action=move&targetId=${id}&x=1`,
      readHeaders,
    );
    expect(withId.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/categories/${id}/impact?action=move&targetId=${id}`,
    );
    const top = await run(
      'GET',
      `catalog/admin/categories/${id}/impact?action=move&targetId=top`,
      readHeaders,
    );
    expect(top.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/categories/${id}/impact?action=move&targetId=top`,
    );
    const bad = await run(
      'GET',
      `catalog/admin/categories/${id}/impact?action=merge&targetId=../x`,
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/categories/${id}/impact?action=merge`,
    );
  });

  it('passes only the known, well-formed filters of the attribute list', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/attributes?search=heat&type=select&status=draft&usedIn=${id}&missing=fa-IR&afterId=${id}&limit=50&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/attributes?search=heat&type=select&status=draft&usedIn=${id}&missing=fa-IR&afterId=${id}&limit=50`,
    );
    const bad = await run(
      'GET',
      `catalog/admin/attributes?search=${'x'.repeat(121)}&type=colour&status=gone&usedIn=nope&missing=Persian&afterId=1&limit=abc`,
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/attributes');
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

describe('relay of the product list', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const get = (target: string) =>
    new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['catalog', 'admin', 'products'];

  it('forwards the list query keys whose value has the right shape, and drops the rest', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        `catalog/admin/products?view=all&q=lamb%20cutlets&scope=SELLER&status=withdrawn&categoryId=${id}&sort=name&direction=asc&page=2&pageSize=25&extra=1`,
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/products?view=all&q=lamb+cutlets&scope=SELLER&status=withdrawn&categoryId=${id}&sort=name&direction=asc&page=2&pageSize=25`,
    );
    await relay(
      config,
      get(
        'catalog/admin/products?view=draft&scope=ALL&categoryId=nope&sort=price&page=-1&pageSize=999',
      ),
      path,
      upstream,
    );
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/admin/products');
  });

  it('relays the public category tree and the thumbnail of one product photo, GET only', async () => {
    const upstream = upstreamOk();
    expect(
      (await relay(config, get('catalog/categories?x=1'), ['catalog', 'categories'], upstream))
        .status,
    ).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/categories');
    const photo = ['catalog', 'admin', 'products', id, 'images', id, 'thumb'];
    expect((await relay(config, get(photo.join('/')), photo, upstream)).status).toBe(200);
    expect(upstream.mock.calls[1]?.[0]).toBe(`http://api.test/${photo.join('/')}`);
  });

  it('passes the Paused status of the list, and drops a status it does not know', async () => {
    const upstream = upstreamOk();
    await relay(config, get('catalog/admin/products?view=inactive&status=paused'), path, upstream);
    await relay(config, get('catalog/admin/products?status=deleted'), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/products?view=inactive&status=paused',
    );
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/admin/products');
  });

  describe('the bulk action and the export', () => {
    const exportPath = ['catalog', 'admin', 'products', 'export'];
    const second = '0190a000-0000-7000-8000-000000000002';

    it('relays the bulk action as a same-origin POST only', async () => {
      const upstream = upstreamOk();
      const bulk = ['catalog', 'admin', 'products', 'bulk'];
      const body = JSON.stringify({ action: 'pause', productIds: [id] });

      expect(
        (await relay(config, post('catalog/admin/products/bulk', sameOrigin, body), bulk, upstream))
          .status,
      ).toBe(200);
      expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/products/bulk');
      // A cross-site request is refused before it reaches the API.
      expect(
        (
          await relay(
            config,
            post('catalog/admin/products/bulk', { host: 'admin.localhost:3002' }, body),
            bulk,
            upstream,
          )
        ).status,
      ).toBe(403);
      // Not a read, and no other path under it.
      expect((await relay(config, get('catalog/admin/products/bulk'), bulk, upstream)).status).toBe(
        404,
      );
      const other = ['catalog', 'admin', 'products', 'bulk', 'x'];
      expect((await relay(config, post(other.join('/')), other, upstream)).status).toBe(404);
      expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('refuses a body over 16 KB', async () => {
      const upstream = upstreamOk();
      const big = JSON.stringify({ action: 'pause', productIds: [], pad: 'x'.repeat(17 * 1024) });
      const response = await relay(
        config,
        post('catalog/admin/products/bulk', sameOrigin, big),
        ['catalog', 'admin', 'products', 'bulk'],
        upstream,
      );
      expect(response.status).toBe(413);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('relays the export with the ids, columns and list query that have the right shape', async () => {
      const upstream = upstreamOk();
      await relay(
        config,
        get(
          `catalog/admin/products/export?format=csv&columns=code,offers&ids=${id},${second}&view=all&q=lamb&extra=1`,
        ),
        exportPath,
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/catalog/admin/products/export?format=csv&columns=code%2Coffers&ids=${id}%2C${second}&view=all&q=lamb`,
      );
    });

    it('relays the Tags column, and all eight columns at once', async () => {
      const upstream = upstreamOk();
      await relay(
        config,
        get('catalog/admin/products/export?columns=code,tags'),
        exportPath,
        upstream,
      );
      await relay(
        config,
        get(
          'catalog/admin/products/export?columns=code,offers,updated,type,scope,seller,created,tags',
        ),
        exportPath,
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(
        'http://api.test/catalog/admin/products/export?columns=code%2Ctags',
      );
      expect(upstream.mock.calls[1]?.[0]).toBe(
        'http://api.test/catalog/admin/products/export?columns=code%2Coffers%2Cupdated%2Ctype%2Cscope%2Cseller%2Ccreated%2Ctags',
      );
    });

    it('relays the xlsx format and drops any other', async () => {
      const upstream = upstreamOk();
      await relay(config, get('catalog/admin/products/export?format=xlsx'), exportPath, upstream);
      await relay(config, get('catalog/admin/products/export?format=xls'), exportPath, upstream);
      await relay(config, get('catalog/admin/products/export?format=XLSX'), exportPath, upstream);
      expect(upstream.mock.calls[0]?.[0]).toBe(
        'http://api.test/catalog/admin/products/export?format=xlsx',
      );
      expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/admin/products/export');
      expect(upstream.mock.calls[2]?.[0]).toBe('http://api.test/catalog/admin/products/export');
    });

    it('passes 200 ids and drops a list of 201 and a bad column', async () => {
      const upstream = upstreamOk();
      const ids = (n: number) =>
        Array.from(
          { length: n },
          (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ).join(',');
      await relay(
        config,
        get(`catalog/admin/products/export?ids=${ids(200)}`),
        exportPath,
        upstream,
      );
      await relay(
        config,
        get(`catalog/admin/products/export?ids=${ids(201)}`),
        exportPath,
        upstream,
      );
      await relay(
        config,
        get('catalog/admin/products/export?columns=code,secret'),
        exportPath,
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toContain(encodeURIComponent(ids(200)));
      expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/admin/products/export');
      expect(upstream.mock.calls[2]?.[0]).toBe('http://api.test/catalog/admin/products/export');
    });

    it('relays an xlsx export byte for byte, with its type and attachment name', async () => {
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f]);
      const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const upstream = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: {
              'content-type': type,
              'content-disposition': 'attachment; filename="products-2026-10-31.xlsx"',
            },
          }),
        ),
      );
      const response = await relay(
        config,
        get('catalog/admin/products/export?format=xlsx'),
        exportPath,
        upstream,
      );
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="products-2026-10-31.xlsx"',
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    });

    it('does not relay an export as a write', async () => {
      const upstream = upstreamOk();
      expect(
        (await relay(config, post('catalog/admin/products/export'), exportPath, upstream)).status,
      ).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  describe('the platform product form', () => {
    const request = (method: string, path: string) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        ...(method === 'GET' ? {} : { body: '{}' }),
      });

    it('relays the options, one product, the create, the draft save and the submit', async () => {
      for (const [method, path] of [
        ['GET', 'catalog/admin/platform-products/options'],
        ['GET', `catalog/admin/platform-products/${id}`],
        ['POST', 'catalog/admin/platform-products'],
        ['PUT', `catalog/admin/platform-products/${id}/draft`],
        ['POST', `catalog/admin/platform-products/${id}/submit`],
        ['POST', `catalog/admin/platform-products/${id}/discard`],
        ['GET', `catalog/admin/platform-products/${id}/images`],
        ['POST', `catalog/admin/platform-products/${id}/images`],
        ['DELETE', `catalog/admin/platform-products/${id}/images/${id}`],
      ] as const) {
        const ok = upstreamOk();
        expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
        expect(ok.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
      }
    });

    it('refuses other methods, other shapes of id and other paths', async () => {
      for (const [method, path] of [
        ['GET', 'catalog/admin/platform-products'],
        ['PUT', 'catalog/admin/platform-products'],
        ['PUT', 'catalog/admin/platform-products/options'],
        ['GET', 'catalog/admin/platform-products/not-a-uuid'],
        ['GET', `catalog/admin/platform-products/${id}/draft`],
        ['GET', `catalog/admin/platform-products/${id}/submit`],
        ['POST', `catalog/admin/platform-products/${id}`],
        ['DELETE', `catalog/admin/platform-products/${id}`],
        ['PUT', `catalog/admin/platform-products/${id}/submit`],
        ['GET', `catalog/admin/platform-products/${id}/discard`],
        ['PUT', `catalog/admin/platform-products/${id}/discard`],
        ['POST', `catalog/admin/platform-products/${id}/retire`],
        ['PUT', `catalog/admin/platform-products/${id}/images`],
        ['DELETE', `catalog/admin/platform-products/${id}/images`],
        ['GET', `catalog/admin/platform-products/${id}/images/${id}`],
        ['POST', `catalog/admin/platform-products/${id}/images/${id}`],
        ['DELETE', `catalog/admin/platform-products/${id}/images/not-a-uuid`],
        ['GET', `catalog/admin/products/${id}/images/${id}/original`],
      ] as const) {
        const fetchImpl = upstreamOk();
        const response = await relay(config, request(method, path), path.split('/'), fetchImpl);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    });
  });

  describe('the certificates card of the product form', () => {
    const base = 'certification/admin/product-certificates';
    const request = (
      method: string,
      path: string,
      body = '{}',
      headers: Record<string, string> = { ...sameOrigin, cookie: '__Host-session-admin-AU=abc' },
    ) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers,
        ...(method === 'GET' ? {} : { body }),
      });

    it('relays exactly the routes the card uses, with a UUID where an id stands', async () => {
      for (const [method, path] of [
        ['GET', `${base}/for-product/${id}`],
        ['GET', `${base}/options`],
        ['GET', `${base}/${id}`],
        ['GET', `${base}/${id}/history`],
        ['POST', base],
        ['PUT', `${base}/${id}/draft`],
        ['POST', `${base}/${id}/documents`],
        ['POST', `${base}/${id}/submit`],
      ] as const) {
        const upstream = upstreamOk();
        const response = await relay(config, request(method, path), path.split('/'), upstream);
        expect(response.status, `${method} ${path}`).toBe(200);
        expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
      }
    });

    it('refuses the reviewer routes, other methods, a malformed id and any other shape', async () => {
      for (const [method, path] of [
        ['GET', base],
        ['GET', `${base}/not-a-uuid`],
        ['GET', `${base}/for-product/not-a-uuid`],
        ['GET', `${base}/for-product`],
        ['GET', `${base}/${id}/review`],
        ['GET', `${base}/${id}/draft`],
        ['GET', `${base}/${id}/documents`],
        ['PUT', base],
        ['PUT', `${base}/options`],
        ['POST', `${base}/options`],
        ['POST', `${base}/${id}`],
        ['POST', `${base}/${id}/approve`],
        ['POST', `${base}/${id}/reject`],
        ['POST', `${base}/${id}/suspend`],
        ['POST', `${base}/${id}/revoke`],
        ['POST', `${base}/${id}/reinstate`],
        ['POST', `${base}/${id}/checks`],
        ['POST', `${base}/${id}/draft`],
        ['PUT', `${base}/${id}/submit`],
        ['DELETE', `${base}/${id}/documents/${id}`],
        ['DELETE', `${base}/${id}`],
      ] as const) {
        const upstream = upstreamOk();
        const response = await relay(config, request(method, path), path.split('/'), upstream);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(upstream).not.toHaveBeenCalled();
      }
    });

    it('lets only the document route carry a file of up to 10 MiB as base64 and keeps the rest at 16 KB', async () => {
      const upstream = upstreamOk();
      const documents = `${base}/${id}/documents`;
      const large = JSON.stringify({ version: 2, data: 'A'.repeat(13 * 1024 * 1024) });
      expect(
        (await relay(config, request('POST', documents, large), documents.split('/'), upstream))
          .status,
      ).toBe(200);
      const tooLarge = JSON.stringify({ version: 2, data: 'A'.repeat(15 * 1024 * 1024) });
      expect(
        (await relay(config, request('POST', documents, tooLarge), documents.split('/'), upstream))
          .status,
      ).toBe(413);
      for (const path of [`${base}/${id}/submit`, base]) {
        expect(
          (await relay(config, request('POST', path, large), path.split('/'), upstream)).status,
        ).toBe(413);
      }
      const draft = `${base}/${id}/draft`;
      expect(
        (await relay(config, request('PUT', draft, large), draft.split('/'), upstream)).status,
      ).toBe(413);
      expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('refuses a document upload without a session cookie before reading its body', async () => {
      const upstream = upstreamOk();
      const documents = `${base}/${id}/documents`;
      const large = JSON.stringify({ version: 2, data: 'A'.repeat(13 * 1024 * 1024) });
      for (const cookie of [undefined, 'theme=dark', '__Host-session-seller-AU=abc']) {
        const headers: Record<string, string> = {
          ...sameOrigin,
          ...(cookie === undefined ? {} : { cookie }),
        };
        const response = await relay(
          config,
          request('POST', documents, large, headers),
          documents.split('/'),
          upstream,
        );
        expect(response.status, String(cookie)).toBe(401);
        expect(((await response.json()) as { code: string }).code).toBe('session.invalid');
      }
      expect(upstream).not.toHaveBeenCalled();
    });

    it('refuses an unsafe call that is not same-origin', async () => {
      const upstream = upstreamOk();
      const submit = `${base}/${id}/submit`;
      expect(
        (
          await relay(
            config,
            request('POST', submit, '{}', { host: 'admin.localhost:3002' }),
            submit.split('/'),
            upstream,
          )
        ).status,
      ).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  it('lets a platform product photo carry up to 5.8 MB and keeps the draft save at 16 KB', async () => {
    const send = (method: string, path: string, body: string) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        body,
      });
    const images = `catalog/admin/platform-products/${id}/images`;
    const large = JSON.stringify({ data: 'A'.repeat(5 * 1024 * 1024) });
    const tooLarge = JSON.stringify({ data: 'A'.repeat(6 * 1024 * 1024) });
    const upstream = upstreamOk();
    expect(
      (await relay(config, send('POST', images, large), images.split('/'), upstream)).status,
    ).toBe(200);
    expect(
      (await relay(config, send('POST', images, tooLarge), images.split('/'), upstream)).status,
    ).toBe(413);
    const draft = `catalog/admin/platform-products/${id}/draft`;
    expect(
      (await relay(config, send('PUT', draft, large), draft.split('/'), upstream)).status,
    ).toBe(413);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  describe('the saved filters of the product list', () => {
    const base = ['catalog', 'admin', 'saved-filters'];
    const request = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      });

    it('relays the list with its list key, the create, the update and the delete', async () => {
      const upstream = upstreamOk();
      await relay(
        config,
        request('GET', 'catalog/admin/saved-filters?listKey=admin.catalog.products&extra=1'),
        base,
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(
        'http://api.test/catalog/admin/saved-filters?listKey=admin.catalog.products',
      );
      for (const [method, path] of [
        ['POST', 'catalog/admin/saved-filters'],
        ['PUT', `catalog/admin/saved-filters/${id}`],
        ['DELETE', `catalog/admin/saved-filters/${id}`],
      ] as const) {
        const ok = upstreamOk();
        expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
        expect(ok.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
      }
    });

    it('drops a list key of the wrong shape and refuses other methods, ids and origins', async () => {
      const upstream = upstreamOk();
      await relay(
        config,
        request('GET', 'catalog/admin/saved-filters?listKey=Bad%20Key'),
        base,
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/saved-filters');
      for (const [method, path] of [
        ['PUT', 'catalog/admin/saved-filters'],
        ['DELETE', 'catalog/admin/saved-filters'],
        ['PUT', 'catalog/admin/saved-filters/not-a-uuid'],
        ['DELETE', 'catalog/admin/saved-filters/not-a-uuid'],
        ['POST', `catalog/admin/saved-filters/${id}`],
        ['GET', `catalog/admin/saved-filters/${id}`],
        ['DELETE', `catalog/admin/saved-filters/${id}/extra`],
      ] as const) {
        const fetchImpl = upstreamOk();
        const response = await relay(config, request(method, path), path.split('/'), fetchImpl);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(fetchImpl).not.toHaveBeenCalled();
      }
      const cross = upstreamOk();
      const response = await relay(
        config,
        request('POST', 'catalog/admin/saved-filters', { host: 'admin.localhost:3002' }),
        base,
        cross,
      );
      expect(response.status).toBe(403);
      expect(cross).not.toHaveBeenCalled();
    });
  });

  it('relays the large photo of a version review, GET only', async () => {
    const large = ['catalog', 'admin', 'products', id, 'images', id, 'large'];
    expect((await relay(config, get(large.join('/')), large, upstreamOk())).status).toBe(200);
  });

  it('refuses a write, another photo size, a take-down read and a product that is not a UUID', async () => {
    const upstream = upstreamOk();
    expect((await relay(config, post('catalog/admin/products'), path, upstream)).status).toBe(404);
    for (const tail of ['medium', 'original', 'take-down']) {
      const other = ['catalog', 'admin', 'products', id, 'images', id, tail];
      expect((await relay(config, get(other.join('/')), other, upstream)).status).toBe(404);
    }
    const bad = ['catalog', 'admin', 'products', 'nope', 'images', id, 'thumb'];
    expect((await relay(config, get(bad.join('/')), bad, upstream)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the product import', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const base = ['catalog', 'admin', 'platform-imports'];
  const get = (target: string) =>
    new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });

  it('relays the template, the current import and one import, GET only', async () => {
    const upstream = upstreamOk();
    for (const path of [
      [...base, 'template'],
      [...base, 'current'],
      [...base, id],
    ]) {
      expect((await relay(config, get(path.join('/')), path, upstream)).status).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(3);
    const notAnId = [...base, 'nope'];
    expect((await relay(config, get(notAnId.join('/')), notAnId, upstream)).status).toBe(404);
  });

  it('relays the report with its kind only, and passes the file name header back', async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('Row,Problem\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="import-errors.csv"',
          },
        }),
      ),
    );
    const path = [...base, id, 'report'];
    const response = await relay(
      config,
      get(`${path.join('/')}?kind=errors&extra=1`),
      path,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path.join('/')}?kind=errors`);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="import-errors.csv"',
    );
  });

  it('relays the upload, start, resume and discard as same-origin POSTs only', async () => {
    const upstream = upstreamOk();
    expect((await relay(config, post(base.join('/')), base, upstream)).status).toBe(200);
    for (const action of ['start', 'resume', 'discard']) {
      const path = [...base, id, action];
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
      expect(
        (
          await relay(
            config,
            post(path.join('/'), { host: 'admin.localhost:3002' }),
            path,
            upstream,
          )
        ).status,
      ).toBe(403);
    }
    expect(upstream).toHaveBeenCalledTimes(4);
    expect((await relay(config, get(base.join('/')), base, upstream)).status).toBe(404);
  });

  it('lets the upload carry a large body and keeps every other path at 16 KB', async () => {
    const upstream = upstreamOk();
    const large = JSON.stringify({ fileName: 'a.csv', data: 'x'.repeat(2 * 1024 * 1024) });
    expect(
      (await relay(config, post(base.join('/'), sameOrigin, large), base, upstream)).status,
    ).toBe(200);
    const tooLarge = JSON.stringify({ data: 'x'.repeat(15 * 1024 * 1024) });
    expect(
      (await relay(config, post(base.join('/'), sameOrigin, tooLarge), base, upstream)).status,
    ).toBe(413);
    const start = [...base, id, 'start'];
    expect(
      (await relay(config, post(start.join('/'), sameOrigin, large), start, upstream)).status,
    ).toBe(413);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('relay of the category tree import and export (categories C7a)', () => {
  const base = ['catalog', 'admin', 'category-tree'];
  const dryRun = [...base, 'import', 'dry-run'];
  const apply = [...base, 'import', 'apply'];
  const exportPath = [...base, 'export'];
  const get = (target: string) =>
    new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });

  it('relays the dry run and the apply as same-origin POSTs, and the export as a GET, on their exact paths only', async () => {
    const upstream = upstreamOk();
    for (const path of [dryRun, apply]) {
      expect((await relay(config, post(path.join('/')), path, upstream)).status).toBe(200);
      expect((await relay(config, get(path.join('/')), path, upstream)).status).toBe(404);
      expect(
        (
          await relay(
            config,
            post(path.join('/'), { host: 'admin.localhost:3002' }),
            path,
            upstream,
          )
        ).status,
      ).toBe(403);
      const extra = [...path, 'x'];
      expect((await relay(config, post(extra.join('/')), extra, upstream)).status).toBe(404);
    }
    expect((await relay(config, get(exportPath.join('/')), exportPath, upstream)).status).toBe(200);
    expect((await relay(config, post(exportPath.join('/')), exportPath, upstream)).status).toBe(
      404,
    );
    const other = [...base, 'import'];
    expect((await relay(config, post(other.join('/')), other, upstream)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('lets only the two import routes carry a large body', async () => {
    const upstream = upstreamOk();
    const large = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
    for (const path of [dryRun, apply]) {
      expect(
        (await relay(config, post(path.join('/'), sameOrigin, large), path, upstream)).status,
      ).toBe(200);
    }
    const tooLarge = JSON.stringify({ data: 'x'.repeat(15 * 1024 * 1024) });
    expect(
      (await relay(config, post(dryRun.join('/'), sameOrigin, tooLarge), dryRun, upstream)).status,
    ).toBe(413);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('relays the export query that has the right shape only', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      get(`${exportPath.join('/')}?format=xlsx&status=active,hidden&q=rice&extra=1&format2=x`),
      exportPath,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/category-tree/export?format=xlsx&status=active%2Chidden&q=rice',
    );
    await relay(
      config,
      get(`${exportPath.join('/')}?format=pdf&status=gone`),
      exportPath,
      upstream,
    );
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/catalog/admin/category-tree/export');
  });
});

describe('relay of the category image (categories C3c)', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const imageId = '0190a000-0000-7000-8000-000000000002';
  const base = ['catalog', 'admin', 'categories', id];
  const put = (target: string, body = '{}') =>
    new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'PUT',
      headers: sameOrigin,
      body,
    });
  const get = (target: string) =>
    new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });

  it('relays the upload as a same-origin PUT and the removal as a same-origin POST', async () => {
    const upstream = upstreamOk();
    const image = [...base, 'image'];
    expect((await relay(config, put(image.join('/')), image, upstream)).status).toBe(200);
    const remove = [...base, 'image', 'remove'];
    expect((await relay(config, post(remove.join('/')), remove, upstream)).status).toBe(200);
    expect(
      (
        await relay(
          config,
          post(remove.join('/'), { host: 'admin.localhost:3002' }),
          remove,
          upstream,
        )
      ).status,
    ).toBe(403);
    // Not a POST of the image path, not a PUT of the removal, not a malformed id.
    expect((await relay(config, post(image.join('/')), image, upstream)).status).toBe(404);
    expect((await relay(config, put(remove.join('/')), remove, upstream)).status).toBe(404);
    const bad = ['catalog', 'admin', 'categories', 'nope', 'image'];
    expect((await relay(config, put(bad.join('/')), bad, upstream)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('lets the upload carry a picture of up to 5.8 MB and keeps the removal at 16 KB', async () => {
    const upstream = upstreamOk();
    const image = [...base, 'image'];
    const large = JSON.stringify({ version: 1, data: 'A'.repeat(5 * 1024 * 1024) });
    expect((await relay(config, put(image.join('/'), large), image, upstream)).status).toBe(200);
    const tooLarge = JSON.stringify({ version: 1, data: 'A'.repeat(6 * 1024 * 1024) });
    expect((await relay(config, put(image.join('/'), tooLarge), image, upstream)).status).toBe(413);
    const remove = [...base, 'image', 'remove'];
    expect(
      (await relay(config, post(remove.join('/'), sameOrigin, large), remove, upstream)).status,
    ).toBe(413);
    const details = ['catalog', 'admin', 'categories', id];
    const patch = new Request(`http://admin.localhost:3002/api/${details.join('/')}`, {
      method: 'PATCH',
      headers: sameOrigin,
      body: large,
    });
    expect((await relay(config, patch, details, upstream)).status).toBe(413);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('relays the medium rendition of the current image, GET only, no other size', async () => {
    const upstream = upstreamOk();
    const medium = [...base, 'images', imageId, 'medium'];
    expect((await relay(config, get(medium.join('/')), medium, upstream)).status).toBe(200);
    for (const size of ['large', 'thumb', 'raw']) {
      const other = [...base, 'images', imageId, size];
      expect((await relay(config, get(other.join('/')), other, upstream)).status).toBe(404);
    }
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('relay of the order list views', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const request = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    });

  it('relays the saved views with the admin list key only', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      request('GET', 'ordering/admin/saved-filters?listKey=admin.ordering.orders&extra=1'),
      ['ordering', 'admin', 'saved-filters'],
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/ordering/admin/saved-filters?listKey=admin.ordering.orders',
    );
    for (const [method, path] of [
      ['POST', 'ordering/admin/saved-filters'],
      ['PUT', `ordering/admin/saved-filters/${id}`],
      ['DELETE', `ordering/admin/saved-filters/${id}`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
      expect(ok.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
    }
  });

  it('refuses other methods and ids on the saved views', async () => {
    for (const [method, path, headers] of [
      ['PUT', 'ordering/admin/saved-filters', sameOrigin],
      ['DELETE', 'ordering/admin/saved-filters', sameOrigin],
      ['PUT', 'ordering/admin/saved-filters/not-a-uuid', sameOrigin],
      ['POST', `ordering/admin/saved-filters/${id}`, sameOrigin],
      ['GET', `ordering/admin/saved-filters/${id}`, sameOrigin],
    ] as const) {
      const fetchImpl = upstreamOk();
      const response = await relay(
        config,
        request(method, path, headers),
        path.split('/'),
        fetchImpl,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});
