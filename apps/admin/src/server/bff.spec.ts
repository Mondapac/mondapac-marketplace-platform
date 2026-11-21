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

describe('relay of the Sellers super list (list 15)', () => {
  it.each(['sellers/admin/sellers/list', 'sellers/admin/sellers/export'])(
    'relays %s as a same-origin POST with its body, and nothing else',
    async (path) => {
      const fetchImpl = upstreamOk();
      const body = JSON.stringify({ view: 'awaiting-review', q: 'al', page: 2, pageSize: 50 });
      const relayed = await relay(config, post(path, sameOrigin, body), path.split('/'), fetchImpl);
      expect(relayed.status).toBe(200);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });

      const refused = upstreamOk();
      const get = new Request(`http://admin.localhost:3002/api/${path}?view=all`, {
        method: 'GET',
        headers: sameOrigin,
      });
      expect((await relay(config, get, path.split('/'), refused)).status).toBe(404);
      const crossSite = post(path, { ...sameOrigin, 'sec-fetch-site': 'cross-site' });
      expect((await relay(config, crossSite, path.split('/'), refused)).status).toBe(403);
      const near = `${path}/x`;
      expect((await relay(config, post(near), near.split('/'), refused)).status).toBe(404);
      expect(refused).not.toHaveBeenCalled();
    },
  );

  it('carries an export of 200 ticked ids under the body cap', async () => {
    const fetchImpl = upstreamOk();
    const ids = Array.from(
      { length: 200 },
      (_, i) => `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');
    const path = 'sellers/admin/sellers/export';
    const body = JSON.stringify({ format: 'xlsx', columns: 'seller-id', ids });
    expect(
      (await relay(config, post(path, sameOrigin, body), path.split('/'), fetchImpl)).status,
    ).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('forwards the note of a reviewed role edit, role change and enabling unchanged', async () => {
    const body = '{"note":"Covers nights"}';
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['PUT', `identity/admin/roles/${ID}`],
      ['POST', `identity/admin/accounts/${ID}/role`],
      ['POST', `identity/admin/accounts/${ID}/enable`],
    ];
    for (const [method, path] of cases) {
      const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
      const request = new Request(`http://admin.localhost:3002/api/${path}`, {
        method,
        headers: sameOrigin,
        body,
      });
      expect((await relay(config, request, path.split('/'), fetchImpl)).status).toBe(200);
      const sent = fetchImpl.mock.calls[0]?.[1]?.body;
      const text =
        sent instanceof ArrayBuffer ? new TextDecoder().decode(sent) : JSON.stringify(sent);
      expect(text).toContain('Covers nights');
    }
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

  it('relays Move products as a POST and its progress as a GET on the exact path only (categories C5a)', async () => {
    const path = `catalog/admin/categories/${ID}/move-products`;
    const read = new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, path.split('/'), fetchImpl)).status).toBe(200);
    expect((await call('POST', path)).status).toBe(200);
    expect((await call('PUT', path)).status).toBe(404);
    expect((await call('DELETE', path)).status).toBe(404);
    expect((await call('POST', `${path}/extra`)).status).toBe(404);
    expect((await call('POST', 'catalog/admin/categories/not-a-uuid/move-products')).status).toBe(
      404,
    );
  });

  it('relays the platform product category picker as a GET on its exact path only (categories C5a)', async () => {
    const path = 'catalog/admin/platform-products/category-picker';
    const read = new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect((await relay(config, read, path.split('/'), fetchImpl)).status).toBe(200);
    expect((await call('POST', path)).status).toBe(404);
    const extra = new Request(`http://admin.localhost:3002/api/${path}/extra`, {
      headers: sameOrigin,
    });
    expect((await relay(config, extra, [...path.split('/'), 'extra'], fetchImpl)).status).toBe(404);
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

  it('relays the assistant insights read on its exact path, with only its own query keys', async () => {
    const path = 'assistant/admin/insights';
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const upstream = () => {
      const target = fetchImpl.mock.calls.at(-1)?.[0];
      return target instanceof Request ? target.url : String(target);
    };
    const ask = (query: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}${query}`, { headers: sameOrigin }),
        path.split('/'),
        fetchImpl,
      );
    expect((await ask('?from=2026-11-01&to=2026-11-20&page=2&pageSize=100')).status).toBe(200);
    expect(upstream()).toContain('from=2026-11-01&to=2026-11-20&page=2&pageSize=100');
    // A key the route does not take, and a value of the wrong shape, are dropped.
    expect((await ask('?secret=1')).status).toBe(200);
    expect(upstream()).not.toContain('secret');
    expect((await ask('?from=yesterday')).status).toBe(200);
    expect(upstream()).not.toContain('yesterday');
    expect((await call('POST', path)).status).toBe(404);
    expect((await call('PUT', path)).status).toBe(404);
    const extra = new Request(`http://admin.localhost:3002/api/${path}/extra`, {
      headers: sameOrigin,
    });
    expect((await relay(config, extra, [...path.split('/'), 'extra'], fetchImpl)).status).toBe(404);
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

  it('forwards the seller page lists and their exports only in the shapes the API takes', async () => {
    const send = async (path: string) => {
      const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
      const [route] = path.split('?');
      const response = await relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}`, {
          method: 'GET',
          headers: { host: 'admin.localhost:3002' },
        }),
        route!.split('/'),
        upstream,
      );
      return { status: response.status, url: upstream.mock.calls[0]?.[0] };
    };
    const ledger = `commission-payouts/admin/sellers/${ID}/ledger`;
    const holds = `commission-payouts/admin/sellers/${ID}/payout-holds`;
    const cursor = `1762041600000.${ID}`;
    expect((await send(`${ledger}?limit=20&cursor=${cursor}&x=1`)).url).toBe(
      `http://api.test/${ledger}?limit=20&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(
      (await send(`${ledger}?cursor=c1&kind=tip&side=debit&q=${ID}&sort=amount&page=2`)).url,
    ).toBe(`http://api.test/${ledger}?side=debit&q=${ID}&sort=amount&page=2`);
    expect((await send(`${ledger}?kind=cashback-seller&side=debit`)).url).toBe(
      `http://api.test/${ledger}?kind=cashback-seller&side=debit`,
    );
    const ids = Array.from({ length: 200 }, () => ID).join(',');
    const file = await send(`${ledger}/export?format=xlsx&columns=rate,entry-id&ids=${ids}`);
    expect(file.status).toBe(200);
    expect(file.url).toBe(
      `http://api.test/${ledger}/export?format=xlsx&columns=rate%2Centry-id&ids=${encodeURIComponent(ids)}`,
    );
    expect(
      (
        await send(
          `${holds}?status=active&scope=order&reason=dispute&origin=system&sort=active-first&page=1&pageSize=100&x=1`,
        )
      ).url,
    ).toBe(
      `http://api.test/${holds}?status=active&reason=dispute&origin=system&scope=order&sort=active-first&page=1&pageSize=100`,
    );
    expect((await send(`${holds}?status=lost&pageSize=500`)).url).toBe(`http://api.test/${holds}`);
    expect((await send(`${holds}/export?columns=hold-id&sellerOrderId=${ID}`)).url).toBe(
      `http://api.test/${holds}/export?columns=hold-id&sellerOrderId=${ID}`,
    );
    expect((await send(`commission-payouts/admin/sellers/nope/ledger/export`)).status).toBe(404);
  });

  it.each([
    ['ledger', 'q'],
    ['payout-holds', 'sellerOrderId'],
  ])(
    'refuses a malformed order key of the seller %s list and its export, never dropping it',
    async (list, key) => {
      const base = `commission-payouts/admin/sellers/${ID}/${list}`;
      const many = Array.from({ length: 201 }, () => ID).join(',');
      const cases = [
        `${base}?${key}=someone`,
        `${base}?${key}=nope&${key}=${ID}`,
        `${base}/export?${key}=someone`,
        `${base}/export?format=csv&${key}=`,
        `${base}/export?ids=${many}`,
        `${base}/export?ids=not-an-id`,
        `${base}/export?format=xls`,
        `${base}/export?columns=secret`,
        `${base}/export?from=yesterday&${key}=${ID}`,
        `${base}/export?sort=secret`,
      ];
      for (const target of cases) {
        const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
        const response = await relay(
          config,
          new Request(`http://admin.localhost:3002/api/${target}`, {
            method: 'GET',
            headers: { host: 'admin.localhost:3002' },
          }),
          target.split('?')[0]!.split('/'),
          upstream,
        );
        const isList = !target.includes('/export');
        // The list drops a value that is not its own shape, except the order key it is scoped by.
        if (isList && !target.includes(`${key}=`)) continue;
        expect(response.status, target).toBe(400);
        expect(upstream, target).not.toHaveBeenCalled();
      }
      // A good order id crosses on both.
      const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
      const good = `${base}/export?${key}=${ID}&format=csv`;
      const response = await relay(
        config,
        new Request(`http://admin.localhost:3002/api/${good}`, {
          method: 'GET',
          headers: { host: 'admin.localhost:3002' },
        }),
        good.split('?')[0]!.split('/'),
        upstream,
      );
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

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
    expect((await call('PUT', `sellers/admin/${ID}/blog-access`)).status).toBe(200);
    expect((await call('PUT', 'sellers/admin/nope/blog-access')).status).toBe(404);
    expect((await call('POST', `sellers/admin/${ID}/blog-access`)).status).toBe(404);
    expect((await read(`sellers/admin/${ID}/blog-access`)).status).toBe(404);
  });

  it('relays the ship-to retention on GET and PUT only, with no query', async () => {
    const path = 'ordering/admin/ship-to-retention';
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
    const send = (method: string, target: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${target}`, { method, headers: sameOrigin }),
        target.split('?')[0]!.split('/'),
        fetcher,
      );
    expect((await send('GET', path)).status).toBe(200);
    expect((await send('PUT', path)).status).toBe(200);
    expect((await send('GET', `${path}?x=1`)).status).toBe(200);
    expect(fetcher.mock.calls[2]?.[0] as string).toMatch(/ship-to-retention$/);
    expect((await send('DELETE', path)).status).toBe(404);
    expect((await send('POST', path)).status).toBe(404);
  });

  it('relays the refund caps on their exact methods, with only the seller id and version in a query', async () => {
    const caps = 'ordering/admin/refund-limits';
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
    const send = (method: string, path: string) =>
      relay(
        config,
        new Request(`http://admin.localhost:3002/api/${path}`, {
          method,
          headers: sameOrigin,
        }),
        path.split('?')[0]!.split('/'),
        fetcher,
      );
    expect((await send('GET', caps)).status).toBe(200);
    expect((await send('GET', `${caps}?sellerId=${ID}&other=1`)).status).toBe(200);
    expect(fetcher.mock.calls[1]?.[0] as string).toMatch(/refund-limits\?sellerId=[0-9a-f-]{36}$/);
    expect((await send('PUT', caps)).status).toBe(200);
    expect((await send('PUT', `${caps}/sellers/${ID}`)).status).toBe(200);
    expect((await send('DELETE', `${caps}/sellers/${ID}?expectedVersion=3&x=1`)).status).toBe(200);
    expect(fetcher.mock.calls.at(-1)?.[0] as string).toMatch(
      /sellers\/[0-9a-f-]{36}\?expectedVersion=3$/,
    );
    expect((await send('PUT', `${caps}/sellers/nope`)).status).toBe(404);
    expect((await send('DELETE', caps)).status).toBe(404);
    expect((await send('POST', caps)).status).toBe(404);
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
    const bulk = 'catalog/admin/review-queue/bulk-decide';
    expect((await relay(config, request('POST', bulk), bulk.split('/'), upstreamOk())).status).toBe(
      200,
    );
    const notBulk = upstreamOk();
    expect((await relay(config, request('PUT', bulk), bulk.split('/'), notBulk)).status).toBe(404);
    expect(notBulk).not.toHaveBeenCalled();
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

describe('relay of the brands list', () => {
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/catalog/admin/brands${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['catalog', 'admin', 'brands'];

  it('forwards the search text in its shape and drops control characters and long text', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      get(
        '?status=draft&originCountry=NZ&q=Halal%20Co&sort=name&direction=asc&page=2&pageSize=50&paging=pages&x=1',
      ),
      path,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/brands?status=draft&originCountry=NZ&q=Halal+Co&page=2&pageSize=50&paging=pages&sort=name&direction=asc',
    );
    const refused = upstreamOk();
    await relay(config, get(`?q=a%0Ab&search=${'x'.repeat(101)}&status=active`), path, refused);
    expect(refused.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/brands?status=active');
  });

  it('forwards the created range as instants, on the list and the export, and drops other text', async () => {
    const from = '2026-11-14T00:00:00+10:00';
    const to = '2026-11-21T00:00:00+10:00';
    const list = upstreamOk();
    await relay(
      config,
      get(
        `?status=active&createdFrom=${encodeURIComponent(from)}&createdTo=${encodeURIComponent(to)}`,
      ),
      path,
      list,
    );
    expect(new URL(list.mock.calls[0]?.[0] as string).searchParams.get('createdFrom')).toBe(from);
    expect(new URL(list.mock.calls[0]?.[0] as string).searchParams.get('createdTo')).toBe(to);
    const file = upstreamOk();
    await relay(
      config,
      new Request(
        `http://admin.localhost:3002/api/catalog/admin/brands/export?format=csv&createdFrom=${encodeURIComponent(from)}`,
        { method: 'GET', headers: { host: 'admin.localhost:3002' } },
      ),
      [...path, 'export'],
      file,
    );
    expect(new URL(file.mock.calls[0]?.[0] as string).searchParams.get('createdFrom')).toBe(from);
    const refused = upstreamOk();
    await relay(
      config,
      get('?status=active&createdFrom=yesterday&createdTo=2026-11-21'),
      path,
      refused,
    );
    expect(refused.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/brands?status=active');
  });

  it('refuses an origin country that is not two capital letters, on the list and the export', async () => {
    for (const bad of ['nz', 'NZL', 'N', 'N%0A']) {
      const list = upstreamOk();
      await relay(config, get(`?originCountry=${bad}&status=active`), path, list);
      expect(list.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/brands?status=active');
      const file = upstreamOk();
      await relay(
        config,
        new Request(
          `http://admin.localhost:3002/api/catalog/admin/brands/export?originCountry=${bad}&format=csv`,
          { method: 'GET', headers: { host: 'admin.localhost:3002' } },
        ),
        [...path, 'export'],
        file,
      );
      expect(file.mock.calls[0]?.[0]).toBe(
        'http://api.test/catalog/admin/brands/export?format=csv',
      );
    }
    const ok = upstreamOk();
    await relay(
      config,
      new Request(
        'http://admin.localhost:3002/api/catalog/admin/brands/export?format=xlsx&status=draft&originCountry=NZ&q=Halal',
        { method: 'GET', headers: { host: 'admin.localhost:3002' } },
      ),
      [...path, 'export'],
      ok,
    );
    expect(ok.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/brands/export?format=xlsx&status=draft&originCountry=NZ&q=Halal',
    );
  });
});

describe('relay of the created range on the activities and tags lists', () => {
  const from = '2026-11-14T00:00:00+10:00';
  const to = '2026-11-21T00:00:00+10:00';
  const get = (target: string, query: string) =>
    new Request(`http://admin.localhost:3002/api/${target}?${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });

  it.each(['business-activities', 'topics'])(
    'forwards createdFrom and createdTo of %s as instants and drops other text',
    async (name) => {
      const target = `catalog/admin/${name}`;
      const list = upstreamOk();
      await relay(
        config,
        get(target, `createdFrom=${encodeURIComponent(from)}&createdTo=${encodeURIComponent(to)}`),
        target.split('/'),
        list,
      );
      const asked = new URL(list.mock.calls[0]?.[0] as string).searchParams;
      expect(asked.get('createdFrom')).toBe(from);
      expect(asked.get('createdTo')).toBe(to);
      const refused = upstreamOk();
      await relay(
        config,
        get(target, 'createdFrom=yesterday&createdTo=2026-11-21'),
        target.split('/'),
        refused,
      );
      expect(refused.mock.calls[0]?.[0]).toBe(`http://api.test/${target}`);
    },
  );
});

describe('relay of the connected accounts list', () => {
  const get = (query: string, suffix = '') =>
    new Request(
      `http://admin.localhost:3002/api/payments/admin/connected-accounts${suffix}${query}`,
      { method: 'GET', headers: { host: 'admin.localhost:3002' } },
    );
  const path = ['payments', 'admin', 'connected-accounts'];
  const ID = '01990000-0000-7000-8000-000000000051';

  it('forwards the list keys in their shapes, and drops the rest', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        `?status=pending&ready=no&requirements=past-due&waiting=paused&q=Halal%20Corner&from=2026-11-01T00:00:00Z&sort=last-read&direction=asc&page=2&pageSize=50&paging=pages&limit=500&x=1`,
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/payments/admin/connected-accounts?status=pending&ready=no&requirements=past-due&waiting=paused&q=Halal+Corner&from=2026-11-01T00%3A00%3A00Z&sort=last-read&direction=asc&page=2&pageSize=50&paging=pages',
    );
    const cursor = `1790000000000.${ID}`;
    const older = upstreamOk();
    await relay(config, get(`?status=enabled&cursor=${cursor}&sort=name`), path, older);
    expect(older.mock.calls[0]?.[0]).toBe(
      `http://api.test/payments/admin/connected-accounts?status=enabled&cursor=${encodeURIComponent(cursor)}`,
    );
  });

  it('forwards the export keys, and refuses an export value out of shape instead of widening the file', async () => {
    const exportPath = [...path, 'export'];
    const upstream = upstreamOk();
    await relay(
      config,
      get(`?format=xlsx&columns=paused,seller-id&ids=${ID}&status=enabled&page=2`, '/export'),
      exportPath,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/payments/admin/connected-accounts/export?format=xlsx&columns=${encodeURIComponent('paused,seller-id')}&ids=${ID}&status=enabled`,
    );
    const many = Array.from({ length: 201 }, () => ID).join(',');
    for (const query of ['?status=open', '?ids=x', `?ids=${many}`, '?columns=stripe']) {
      const refused = upstreamOk();
      const response = await relay(config, get(query, '/export'), exportPath, refused);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'validation.failed' });
      expect(refused).not.toHaveBeenCalled();
    }
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

describe('relay of the customers list and customer page', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = (target: string) =>
    new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const pathOf = (target: string) => target.split('?')[0]!.split('/');

  it("forwards one customer's orders (accountId, a UUID only)", async () => {
    const upstream = upstreamOk();
    const target = `ordering/admin/orders?accountId=${ID}&page=1`;
    await relay(config, get(target), pathOf(target), upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/ordering/admin/orders?accountId=${ID}&page=1`,
    );
    // A malformed scope is refused, never dropped (that would list the whole Market's orders).
    const bad = 'ordering/admin/orders?accountId=someone&page=1';
    const refused = await relay(config, get(bad), pathOf(bad), upstream);
    expect(refused.status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('relays the Money tab reads that the client builds from a variable path', async () => {
    for (const target of [
      `ordering/admin/customers/${ID}/refunds`,
      `promotions/admin/customers/${ID}/credits`,
      `wallet/admin/customers/${ID}/history`,
    ]) {
      const upstream = upstreamOk();
      const response = await relay(config, get(target), pathOf(target), upstream);
      expect(response.status).toBe(200);
    }
  });

  it('forwards the wallet journal and promotion credit paging, and nothing else', async () => {
    const upstream = upstreamOk();
    const wallet = `wallet/admin/customers/${ID}/history?limit=20&cursor=abc.1&x=1`;
    await relay(config, get(wallet), pathOf(wallet), upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/wallet/admin/customers/${ID}/history?cursor=abc.1&limit=20`,
    );
    const credits = `promotions/admin/customers/${ID}/credits?limit=100&cursor=a%20b`;
    await relay(config, get(credits), pathOf(credits), upstream);
    expect(upstream.mock.calls[1]?.[0]).toBe(
      `http://api.test/promotions/admin/customers/${ID}/credits?limit=100`,
    );
  });

  it('takes an export naming 1000 ticked ids, and still caps a larger body', async () => {
    const upstream = upstreamOk();
    const ids = Array.from({ length: 1000 }, () => ID);
    const body = JSON.stringify({ format: 'csv', columns: ['name'], ids });
    expect(body.length).toBeGreaterThan(16 * 1024);
    const path = ['customers', 'admin', 'export'];
    const ok = await relay(config, post(path.join('/'), sameOrigin, body), path, upstream);
    expect(ok.status).toBe(200);
    const big = await relay(
      config,
      post(path.join('/'), sameOrigin, 'x'.repeat(48 * 1024 + 1)),
      path,
      upstream,
    );
    expect(big.status).toBe(413);
    // The larger cap is the export's only.
    const list = ['customers', 'admin', 'list'];
    const other = await relay(config, post(list.join('/'), sameOrigin, body), list, upstream);
    expect(other.status).toBe(413);
  });

  describe('customers phase 2b, part A: payments, disputes, refunds and promotion usages', () => {
    const send = (method: string, target: string, body = '{}') =>
      new Request(`http://admin.localhost:3002/api/${target}`, {
        method,
        headers: {
          ...sameOrigin,
          host: 'admin.localhost:3002',
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body }),
      });

    it.each([
      ['POST', `payments/admin/customers/${ID}/payments`],
      ['POST', `payments/admin/customers/${ID}/payments/export`],
      ['POST', `payments/admin/customers/${ID}/disputes`],
      ['POST', `payments/admin/customers/${ID}/disputes/export`],
      ['POST', `ordering/admin/customers/${ID}/refunds`],
      ['POST', `ordering/admin/customers/${ID}/refunds/export`],
      ['GET', `promotions/admin/customers/${ID}/usages?limit=50&cursor=abc.1`],
    ])('relays %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(200);
    });

    it.each([
      ['GET', `payments/admin/customers/${ID}/payments`],
      ['GET', `payments/admin/customers/${ID}/disputes`],
      ['PUT', `payments/admin/customers/${ID}/payments`],
      ['POST', `payments/admin/customers/${ID}/payments/purge`],
      ['POST', `promotions/admin/customers/${ID}/usages`],
      ['DELETE', `ordering/admin/customers/${ID}/refunds`],
      ['POST', `payments/admin/customers/not-a-uuid/payments`],
    ])('refuses %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('forwards only the usages paging keys', async () => {
      const upstream = upstreamOk();
      const target = `promotions/admin/customers/${ID}/usages?limit=50&cursor=abc.1&status=x`;
      await relay(config, send('GET', target), pathOf(target), upstream);
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/promotions/admin/customers/${ID}/usages?limit=50&cursor=abc.1`,
      );
    });
  });

  describe('customers phase 2b part C: shopping and reviews', () => {
    const SECTIONS = [
      'saved-items',
      'cart-reminders',
      'cart-additions',
      'assistant-conversations',
      'reviews',
      'seller-ratings',
      'helpful-votes',
      'review-reports',
    ];
    const send = (method: string, target: string, body = '{}') =>
      new Request(`http://admin.localhost:3002/api/${target}`, {
        method,
        headers: {
          ...sameOrigin,
          host: 'admin.localhost:3002',
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body }),
      });

    it.each([
      ...SECTIONS.flatMap((name) => [
        ['POST', `customers/admin/customers/${ID}/${name}`],
        ['POST', `customers/admin/customers/${ID}/${name}/export`],
      ]),
      ['GET', `customers/admin/customers/${ID}/cart`],
      ['GET', `customers/admin/customers/${ID}/behaviour`],
    ])('relays %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(200);
    });

    it.each([
      ...SECTIONS.flatMap((name) => [
        ['GET', `customers/admin/customers/${ID}/${name}`],
        ['PUT', `customers/admin/customers/${ID}/${name}`],
        ['GET', `customers/admin/customers/${ID}/${name}/export`],
      ]),
      ['POST', `customers/admin/customers/${ID}/cart`],
      ['DELETE', `customers/admin/customers/${ID}/behaviour`],
      ['POST', `customers/admin/customers/${ID}/reviews/purge`],
    ])('refuses %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('takes a list body under the 16 KB cap and refuses a larger one', async () => {
      const upstream = upstreamOk();
      const target = `customers/admin/customers/${ID}/reviews`;
      const big = JSON.stringify({ filters: { status: ['x'.repeat(17 * 1024)] } });
      expect(
        (await relay(config, send('POST', target, big), pathOf(target), upstream)).status,
      ).toBe(413);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('forwards no query string of the cart read', async () => {
      const upstream = upstreamOk();
      const target = `customers/admin/customers/${ID}/cart?x=1`;
      await relay(config, send('GET', target), pathOf(target), upstream);
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/customers/admin/customers/${ID}/cart`,
      );
    });
  });

  describe('customers phases 3 and 4a: seller customers and attributions', () => {
    const send = (method: string, target: string, body = '{}') =>
      new Request(`http://admin.localhost:3002/api/${target}`, {
        method,
        headers: {
          ...sameOrigin,
          host: 'admin.localhost:3002',
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body }),
      });
    const A = 'customers/admin/seller-attributions';
    const S = `customers/admin/sellers/${ID}/customers`;

    it.each([
      ['GET', `${S}/summary`],
      ['POST', `${S}/list`],
      ['POST', `${A}/list`],
      ['POST', `${A}/list/ids`],
      ['POST', `${A}/decide`],
      ['POST', `${A}/export`],
    ])('relays %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(200);
    });

    it.each([
      ['POST', `${S}/summary`],
      ['GET', `${S}/list`],
      ['PUT', `${S}/list`],
      ['GET', `${A}/list`],
      ['GET', `${A}/export`],
      ['DELETE', `${A}/decide`],
      ['POST', `${A}/other`],
      ['POST', 'customers/admin/sellers/not-an-id/customers/list'],
    ])('refuses %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('forwards no query string of the summary read', async () => {
      const upstream = upstreamOk();
      const target = `${S}/summary?x=1`;
      await relay(config, send('GET', target), pathOf(target), upstream);
      expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${S}/summary`);
    });

    it('takes a 1000-id export body and a list body under 16 KB, and refuses a larger list body', async () => {
      const upstream = upstreamOk();
      const ids = JSON.stringify({ ids: Array.from({ length: 1000 }, () => ID) });
      expect(
        (await relay(config, send('POST', `${A}/export`, ids), pathOf(`${A}/export`), upstream))
          .status,
      ).toBe(200);
      const big = JSON.stringify({ q: 'x'.repeat(17 * 1024) });
      expect(
        (await relay(config, send('POST', `${A}/list`, big), pathOf(`${A}/list`), upstream)).status,
      ).toBe(413);
    });
  });

  describe('customers phase 2b, part B: account and security', () => {
    const A = '0190a000-0000-7000-8000-0000000000c1';
    const send = (method: string, target: string, body = '{}') =>
      new Request(`http://admin.localhost:3002/api/${target}`, {
        method,
        headers: {
          ...sameOrigin,
          host: 'admin.localhost:3002',
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body }),
      });
    const base = `customers/admin/customers/${ID}`;

    it.each([
      ['GET', `${base}/sessions`],
      ['GET', `${base}/addresses`],
      ['GET', `${base}/consent`],
      ['GET', `${base}/behaviour`],
      ['POST', `${base}/sign-ins`],
      ['POST', `${base}/sign-ins/${A}/reveal`],
      ['POST', `${base}/sessions/end`],
      ['POST', `${base}/password-reset`],
      ['POST', `${base}/addresses/${A}/reveal`],
      ['POST', `${base}/consent-history`],
      ['POST', `${base}/consent-history/export`],
    ])('relays %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(200);
    });

    it.each([
      ['POST', `${base}/sign-ins/export`],
      ['GET', `${base}/sign-ins`],
      ['POST', `${base}/sign-ins/not-a-uuid/reveal`],
      ['GET', `${base}/sessions/end`],
      ['PUT', `${base}/addresses/${A}/reveal`],
      ['DELETE', `${base}/sessions`],
    ])('refuses %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('drops query keys on the reads', async () => {
      const upstream = upstreamOk();
      const target = `${base}/sessions?limit=5`;
      await relay(config, send('GET', target), pathOf(target), upstream);
      expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${base}/sessions`);
    });
  });

  describe('customers phase 2a: groups, notes, activity and the name edit', () => {
    const G = '0190a000-0000-7000-8000-0000000000b1';
    const send = (method: string, target: string, body = '{}') =>
      new Request(`http://admin.localhost:3002/api/${target}`, {
        method,
        headers: {
          ...sameOrigin,
          host: 'admin.localhost:3002',
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body }),
      });

    it.each([
      ['GET', 'customers/admin/groups'],
      ['POST', 'customers/admin/groups'],
      ['GET', `customers/admin/groups/${G}`],
      ['PUT', `customers/admin/groups/${G}`],
      ['POST', `customers/admin/groups/${G}/members/add`],
      ['POST', `customers/admin/groups/${G}/members/remove`],
      ['GET', `customers/admin/customers/${ID}/notes`],
      ['POST', `customers/admin/customers/${ID}/notes`],
      ['POST', `customers/admin/customers/${ID}/activity`],
      ['POST', `customers/admin/customers/${ID}/activity/export`],
      ['PUT', `customers/admin/customers/${ID}/display-name`],
      ['PUT', `customers/admin/customers/${ID}/email`],
      ['DELETE', `customers/admin/customers/${ID}/email-change`],
    ])('relays %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(200);
    });

    it.each([
      ['DELETE', `customers/admin/groups/${G}`],
      ['PUT', `customers/admin/groups/not-a-uuid`],
      ['POST', `customers/admin/groups/${G}/members/purge`],
      ['GET', `customers/admin/customers/${ID}/activity`],
      ['DELETE', `customers/admin/customers/${ID}/notes`],
      ['POST', `customers/admin/customers/${ID}/email`],
      ['GET', `customers/admin/customers/${ID}/email`],
      ['PATCH', `customers/admin/customers/${ID}/email`],
      ['PUT', `customers/admin/customers/${ID}/email-change`],
      ['POST', `customers/admin/customers/${ID}/email-change`],
      ['DELETE', `customers/admin/customers/${ID}/email`],
      ['PUT', 'customers/admin/customers/not-a-uuid/email'],
    ])('refuses %s %s', async (method, target) => {
      const upstream = upstreamOk();
      const response = await relay(config, send(method, target), pathOf(target), upstream);
      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('caps the email change body at 1 KB, and only on that path', async () => {
      const upstream = upstreamOk();
      const email = `customers/admin/customers/${ID}/email`;
      const small = JSON.stringify({ email: 'new@example.com' });
      expect((await relay(config, send('PUT', email, small), pathOf(email), upstream)).status).toBe(
        200,
      );
      const big = JSON.stringify({ email: `${'a'.repeat(1100)}@example.com` });
      expect((await relay(config, send('PUT', email, big), pathOf(email), upstream)).status).toBe(
        413,
      );
      // Another PUT of the same customer keeps the usual 16 KB cap.
      const name = `customers/admin/customers/${ID}/display-name`;
      const longer = JSON.stringify({ displayName: 'a'.repeat(1100) });
      expect((await relay(config, send('PUT', name, longer), pathOf(name), upstream)).status).toBe(
        200,
      );
    });

    it('forwards only the notes paging keys', async () => {
      const upstream = upstreamOk();
      const target = `customers/admin/customers/${ID}/notes?limit=20&cursor=abc.1&author=x`;
      await relay(config, send('GET', target), pathOf(target), upstream);
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/customers/admin/customers/${ID}/notes?limit=20&cursor=abc.1`,
      );
    });

    it('takes 1000 ticked ids for a members change, and nowhere else on the group', async () => {
      const ids = Array.from({ length: 1000 }, () => ID);
      const body = JSON.stringify({ ids });
      expect(body.length).toBeGreaterThan(16 * 1024);
      const add = `customers/admin/groups/${G}/members/add`;
      const upstream = upstreamOk();
      expect((await relay(config, send('POST', add, body), pathOf(add), upstream)).status).toBe(
        200,
      );
      const rename = `customers/admin/groups/${G}`;
      expect(
        (await relay(config, send('PUT', rename, body), pathOf(rename), upstream)).status,
      ).toBe(413);
    });
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

  it('forwards the search, the reference, the customer account and the paging mode', async () => {
    const upstream = upstreamOk();
    const q =
      'status=confirmed&q=0190a000-0000-7000-8000-000000000001&search=rice&accountId=0190a000-0000-7000-8000-000000000002&page=1&paging=prev-next';
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

describe('relay of the shipments list', () => {
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/shipments${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['ordering', 'admin', 'shipments'];
  const SELLER = '0190a000-0000-7000-8000-0000000000b1';
  const CURSOR = '1763300000000.0190a000-0000-7000-8000-0000000000aa';
  const urlOf = (upstream: ReturnType<typeof upstreamOk>) => {
    const target = upstream.mock.calls[0]?.[0];
    return typeof target === 'string' ? target : '';
  };
  const sent = async (query: string) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(200);
    return new URL(urlOf(upstream)).searchParams;
  };

  it('forwards the page mode, the tab, the filters and the dates', async () => {
    const upstream = upstreamOk();
    const q =
      'page=2&pageSize=25&sort=paid&direction=desc&stage=shipped&deliveryMethod=same_day' +
      '&attention=no-carrier&search=Cedar+Lane&paidFrom=2026-11-16T14%3A00%3A00.000Z' +
      '&paidTo=2026-11-17T14%3A00%3A00.000Z&shippedFrom=2026-11-16T14%3A00%3A00%2B10%3A00' +
      `&shippedTo=2026-11-17T14%3A00%3A00.000Z&sellerId=${SELLER}`;
    await relay(config, get(`?${q}&x=1&fleet=swift`), path, upstream);
    const url = new URL(urlOf(upstream));
    expect(url.origin + url.pathname).toBe('http://api.test/ordering/admin/shipments');
    // The relay writes the keys in its own order; the values are what the panel asked for.
    expect(Object.fromEntries(url.searchParams)).toEqual(
      Object.fromEntries(new URLSearchParams(q)),
    );
  });

  it('forwards the Previous and next mode: limit, cursor, and an exact q', async () => {
    const params = await sent(`?limit=25&cursor=${CURSOR}&q=SC+4471+99`);
    expect(Object.fromEntries(params)).toEqual({ limit: '25', cursor: CURSOR, q: 'SC 4471 99' });
  });

  it('drops a key the panel does not use, such as fleet, and every unknown key', async () => {
    const params = await sent('?stage=ready&fleet=swift&minAmount=1&x=1');
    expect(Object.fromEntries(params)).toEqual({ stage: 'ready' });
  });

  it('drops a value of the wrong shape and keeps the rest', async () => {
    const params = await sent(
      '?stage=cancelled&sort=name&direction=up&deliveryMethod=drone&attention=all' +
        '&sellerId=nope&page=0x&pageSize=1000&limit=-1&cursor=abc&paidFrom=yesterday' +
        '&shippedTo=2026-11-16&q=ok',
    );
    expect(Object.fromEntries(params)).toEqual({ q: 'ok' });
  });

  it('accepts each stage, sort, method and problem the API names', async () => {
    for (const stage of ['to-prepare', 'ready', 'shipped', 'delivered', 'refunded']) {
      expect((await sent(`?stage=${stage}`)).get('stage')).toBe(stage);
    }
    for (const sort of ['paid', 'shipped', 'delivered', 'total']) {
      expect((await sent(`?sort=${sort}`)).get('sort')).toBe(sort);
    }
    for (const method of ['pickup', 'instant', 'same_day', 'scheduled']) {
      expect((await sent(`?deliveryMethod=${method}`)).get('deliveryMethod')).toBe(method);
    }
    for (const attention of ['any', 'no-carrier', 'carrier-unknown', 'cancel-unknown']) {
      expect((await sent(`?attention=${attention}`)).get('attention')).toBe(attention);
    }
  });

  it('keeps free text up to 80 characters for q and search, and drops more', async () => {
    const eighty = 'x'.repeat(80);
    expect((await sent(`?q=${eighty}`)).get('q')).toBe(eighty);
    expect((await sent(`?search=${eighty}`)).get('search')).toBe(eighty);
    expect((await sent(`?q=${eighty}y`)).has('q')).toBe(false);
    expect((await sent(`?search=${eighty}y`)).has('search')).toBe(false);
    expect((await sent('?q=')).has('q')).toBe(false);
  });

  it('refuses other paths and methods', async () => {
    const upstream = upstreamOk();
    const other = ['ordering', 'admin', 'shipments', '0190a000-0000-7000-8000-000000000001'];
    expect((await relay(config, get(''), other, upstream)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const request = new Request('http://admin.localhost:3002/api/ordering/admin/shipments', {
        method,
        headers: sameOrigin,
        body: '{}',
      });
      expect((await relay(config, request, path, upstream)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the refunds list', () => {
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/refunds${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['ordering', 'admin', 'refunds'];
  const SELLER = '0190a000-0000-7000-8000-0000000000b1';
  const CURSOR = '1763300000000.0190a000-0000-7000-8000-0000000000aa';
  const urlOf = (upstream: ReturnType<typeof upstreamOk>) => {
    const target = upstream.mock.calls[0]?.[0];
    return typeof target === 'string' ? target : '';
  };
  const sent = async (query: string) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(200);
    return new URL(urlOf(upstream)).searchParams;
  };

  it('forwards the page mode, the tab, the filters and the dates', async () => {
    const upstream = upstreamOk();
    const q =
      'page=2&pageSize=25&sort=amount&direction=desc&state=succeeded&reason=damaged' +
      '&actor=seller&lossBearer=platform&ledger=waiting&search=Cedar+Lane' +
      '&from=2026-11-16T14%3A00%3A00.000Z&to=2026-11-17T14%3A00%3A00%2B10%3A00' +
      `&sellerId=${SELLER}`;
    await relay(config, get(`?${q}&x=1&minAmount=1&maxAmount=9`), path, upstream);
    const url = new URL(urlOf(upstream));
    expect(url.origin + url.pathname).toBe('http://api.test/ordering/admin/refunds');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      Object.fromEntries(new URLSearchParams(q)),
    );
  });

  it('forwards the Previous and next mode: limit, cursor, and an exact Stripe id as q', async () => {
    const params = await sent(`?limit=25&cursor=${CURSOR}&q=re_3Pabc123`);
    expect(Object.fromEntries(params)).toEqual({ limit: '25', cursor: CURSOR, q: 're_3Pabc123' });
  });

  it('drops the amount filters the panel has no input for, and every unknown key', async () => {
    const params = await sent('?state=pending&minAmount=100&maxAmount=900&stage=ready&x=1');
    expect(Object.fromEntries(params)).toEqual({ state: 'pending' });
  });

  it('drops a value of the wrong shape and keeps the rest', async () => {
    const params = await sent(
      '?state=done&sort=name&direction=up&reason=broken&actor=buyer&lossBearer=carrier' +
        '&ledger=late&sellerId=nope&page=0x&pageSize=1000&limit=-1&cursor=abc&from=yesterday' +
        '&to=2026-11-16&q=ok',
    );
    expect(Object.fromEntries(params)).toEqual({ q: 'ok' });
  });

  it('accepts each state, sort, reason, actor, loss bearer and ledger the API names', async () => {
    for (const state of ['pending', 'succeeded', 'failed']) {
      expect((await sent(`?state=${state}`)).get('state')).toBe(state);
    }
    for (const sort of ['requested', 'settled', 'amount']) {
      expect((await sent(`?sort=${sort}`)).get('sort')).toBe(sort);
    }
    for (const reason of [
      'not-received',
      'damaged',
      'wrong-item',
      'not-as-described',
      'seller-cancelled',
      'item-unavailable',
      'other',
    ]) {
      expect((await sent(`?reason=${reason}`)).get('reason')).toBe(reason);
    }
    for (const actor of ['admin', 'seller']) {
      expect((await sent(`?actor=${actor}`)).get('actor')).toBe(actor);
    }
    for (const bearer of ['seller', 'platform']) {
      expect((await sent(`?lossBearer=${bearer}`)).get('lossBearer')).toBe(bearer);
    }
    for (const ledger of ['waiting', 'recorded']) {
      expect((await sent(`?ledger=${ledger}`)).get('ledger')).toBe(ledger);
    }
  });

  it('keeps free text up to 80 characters for q and search, and drops more', async () => {
    const eighty = 'x'.repeat(80);
    expect((await sent(`?q=${eighty}`)).get('q')).toBe(eighty);
    expect((await sent(`?search=${eighty}`)).get('search')).toBe(eighty);
    expect((await sent(`?q=${eighty}y`)).has('q')).toBe(false);
    expect((await sent(`?search=${eighty}y`)).has('search')).toBe(false);
    expect((await sent('?q=')).has('q')).toBe(false);
  });

  it('refuses other paths and methods', async () => {
    const upstream = upstreamOk();
    const other = ['ordering', 'admin', 'refunds', '0190a000-0000-7000-8000-000000000001'];
    expect((await relay(config, get(''), other, upstream)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const request = new Request('http://admin.localhost:3002/api/ordering/admin/refunds', {
        method,
        headers: sameOrigin,
        body: '{}',
      });
      expect((await relay(config, request, path, upstream)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the invoices list (documents)', () => {
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/documents${query}`, {
      method: 'GET',
      headers: { host: 'admin.localhost:3002' },
    });
  const path = ['ordering', 'admin', 'documents'];
  const SELLER = '0190a000-0000-7000-8000-0000000000b1';
  const CURSOR = '1763300000000.0190a000-0000-7000-8000-0000000000aa';
  const urlOf = (upstream: ReturnType<typeof upstreamOk>) => {
    const target = upstream.mock.calls[0]?.[0];
    return typeof target === 'string' ? target : '';
  };
  const sent = async (query: string) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(200);
    return new URL(urlOf(upstream)).searchParams;
  };

  it('forwards the page mode, the kind, the search, the seller and the dates', async () => {
    const upstream = upstreamOk();
    const q =
      'kind=credit-note&page=2&pageSize=25&sort=amount&direction=asc&search=Cedar+Lane' +
      '&from=2026-11-16T14%3A00%3A00.000Z&to=2026-11-17T14%3A00%3A00%2B10%3A00' +
      `&sellerId=${SELLER}`;
    await relay(config, get(`?${q}&x=1`), path, upstream);
    const url = new URL(urlOf(upstream));
    expect(url.origin + url.pathname).toBe('http://api.test/ordering/admin/documents');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      Object.fromEntries(new URLSearchParams(q)),
    );
  });

  it('forwards the Previous and next mode: limit, cursor, and an exact q', async () => {
    const params = await sent(`?kind=order-confirmation&limit=25&cursor=${CURSOR}&q=${SELLER}`);
    expect(Object.fromEntries(params)).toEqual({
      kind: 'order-confirmation',
      limit: '25',
      cursor: CURSOR,
      q: SELLER,
    });
  });

  it('drops the amount filters and every unknown key', async () => {
    const params = await sent('?kind=credit-note&minAmount=1&maxAmount=9&fleet=x&x=1');
    expect(Object.fromEntries(params)).toEqual({ kind: 'credit-note' });
  });

  it('drops a value of the wrong shape and keeps the rest', async () => {
    const params = await sent(
      '?kind=tax-invoice&sort=name&direction=up&sellerId=nope&page=0x&pageSize=1000' +
        '&limit=-1&cursor=abc&from=yesterday&to=2026-11-16&q=ok',
    );
    expect(Object.fromEntries(params)).toEqual({ q: 'ok' });
  });

  it('accepts each kind and sort the API names', async () => {
    for (const kind of ['order-confirmation', 'credit-note']) {
      expect((await sent(`?kind=${kind}`)).get('kind')).toBe(kind);
    }
    for (const sort of ['issued', 'amount']) {
      expect((await sent(`?sort=${sort}`)).get('sort')).toBe(sort);
    }
  });

  it('keeps free text up to 80 characters for q and search, and drops more', async () => {
    const eighty = 'x'.repeat(80);
    expect((await sent(`?q=${eighty}`)).get('q')).toBe(eighty);
    expect((await sent(`?search=${eighty}`)).get('search')).toBe(eighty);
    expect((await sent(`?q=${eighty}y`)).has('q')).toBe(false);
    expect((await sent(`?search=${eighty}y`)).has('search')).toBe(false);
  });

  it('refuses other paths and methods', async () => {
    const upstream = upstreamOk();
    const other = ['ordering', 'admin', 'documents', '0190a000-0000-7000-8000-000000000001'];
    expect((await relay(config, get(''), other, upstream)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const request = new Request('http://admin.localhost:3002/api/ordering/admin/documents', {
        method,
        headers: sameOrigin,
        body: '{}',
      });
      expect((await relay(config, request, path, upstream)).status).toBe(404);
    }
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

describe('relay of the blog media library', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const send = (method: string, path: string, body?: string) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    });

  it('takes an upload of a 4 MiB picture as base64 (about 5.6 MB) and refuses a larger body', async () => {
    const path = 'blog/admin/media';
    const upstream = upstreamOk();
    const ok = JSON.stringify({ data: 'A'.repeat(5_600 * 1024) });
    expect((await relay(config, send('POST', path, ok), path.split('/'), upstream)).status).toBe(
      200,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/blog/admin/media');
    const big = JSON.stringify({ data: 'A'.repeat(5_900 * 1024) });
    expect((await relay(config, send('POST', path, big), path.split('/'), upstream)).status).toBe(
      413,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps the usual 16 KB cap on the other blog POST routes', async () => {
    const upstream = upstreamOk();
    const path = 'blog/admin/posts';
    const big = JSON.stringify({ pad: 'x'.repeat(17 * 1024) });
    expect((await relay(config, send('POST', path, big), path.split('/'), upstream)).status).toBe(
      413,
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes only a numeric page of the list and drops the rest', async () => {
    const upstream = upstreamOk();
    const list = ['blog', 'admin', 'media'];
    await relay(config, send('GET', 'blog/admin/media?page=3&x=1'), list, upstream);
    await relay(config, send('GET', 'blog/admin/media?page=0x1'), list, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/blog/admin/media?page=3');
    expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/blog/admin/media');
  });

  it('relays the thumb and the large rendition, GET only, no other size', async () => {
    const upstream = upstreamOk();
    for (const size of ['thumb', 'large']) {
      const path = ['blog', 'admin', 'media', id, size];
      expect((await relay(config, send('GET', path.join('/')), path, upstream)).status).toBe(200);
    }
    for (const size of ['raw', 'medium']) {
      const path = ['blog', 'admin', 'media', id, size];
      expect((await relay(config, send('GET', path.join('/')), path, upstream)).status).toBe(404);
    }
    const post = ['blog', 'admin', 'media', id, 'thumb'];
    expect((await relay(config, send('POST', post.join('/'), '{}'), post, upstream)).status).toBe(
      404,
    );
    const bad = ['blog', 'admin', 'media', 'nope', 'thumb'];
    expect((await relay(config, send('GET', bad.join('/')), bad, upstream)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(2);
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

  it('passes the Blog posts super list query and its export only in the shapes the API takes', async () => {
    const seller = '0190a000-0000-7000-8000-0000000000aa';
    const upstream = upstreamOk();
    await relay(
      config,
      request(
        `blog/admin/posts?view=published&owner=seller&sellerId=${seller}&featured=true&q=eid%20sweets&from=2026-11-01T00:00:00Z&sort=published&direction=asc&page=2&pageSize=50&body=x`,
      ),
      list,
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/blog/admin/posts?view=published&owner=seller&sellerId=${seller}&featured=true&q=eid+sweets&from=2026-11-01T00%3A00%3A00Z&sort=published&direction=asc&page=2&pageSize=50`,
    );
    const dropped = upstreamOk();
    await relay(
      config,
      request(
        `blog/admin/posts?view=live&featured=yes&q=${'a'.repeat(101)}&sort=title&pageSize=500&cursor=nope`,
      ),
      list,
      dropped,
    );
    expect(dropped.mock.calls[0]?.[0]).toBe('http://api.test/blog/admin/posts');
    // A ZWNJ (a format character, common in Persian) is forwarded; a control character is not.
    const zwnj = upstreamOk();
    await relay(
      config,
      request(`blog/admin/posts?q=${encodeURIComponent('می\u200Cخواهم')}`),
      list,
      zwnj,
    );
    expect(zwnj.mock.calls[0]?.[0]).toBe(
      `http://api.test/blog/admin/posts?q=${encodeURIComponent('می\u200Cخواهم')}`,
    );
    const control = upstreamOk();
    await relay(config, request('blog/admin/posts?q=eid%07'), list, control);
    expect(control.mock.calls[0]?.[0]).toBe('http://api.test/blog/admin/posts');
    const zwnjExport = upstreamOk();
    await relay(
      config,
      request(`blog/admin/posts/export?format=csv&q=${encodeURIComponent('می\u200Cخواهم')}`),
      [...list, 'export'],
      zwnjExport,
    );
    expect(zwnjExport.mock.calls[0]?.[0]).toBe(
      `http://api.test/blog/admin/posts/export?format=csv&q=${encodeURIComponent('می\u200Cخواهم')}`,
    );
    // The export is strict: a control character in the search refuses it (400), so the file is
    // never wider than the list that was asked for.
    const controlExport = upstreamOk();
    const refused = await relay(
      config,
      request('blog/admin/posts/export?format=csv&q=eid%07'),
      [...list, 'export'],
      controlExport,
    );
    // The export is strict: a malformed search refuses the file instead of widening it.
    expect(refused.status).toBe(400);
    expect(controlExport).not.toHaveBeenCalled();
    const file = upstreamOk();
    await relay(
      config,
      request(
        `blog/admin/posts/export?format=xlsx&columns=slug,published&ids=${seller}&view=all&page=2`,
      ),
      [...list, 'export'],
      file,
    );
    expect(file.mock.calls[0]?.[0]).toBe(
      `http://api.test/blog/admin/posts/export?format=xlsx&columns=slug%2Cpublished&ids=${seller}&view=all`,
    );
  });
});

describe('relay of the blog posts export (strict)', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = async (path: string) => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method: 'GET',
        headers: { host: 'admin.localhost:3002' },
      }),
      path.split('?')[0]!.split('/'),
      upstream,
    );
    return { response, upstream };
  };

  it('refuses a malformed key with no upstream call, instead of widening the file', async () => {
    for (const query of [
      'view=live',
      'kind=podcast',
      'owner=all',
      'featured=yes',
      `q=${'a'.repeat(101)}`,
      'from=2026-11-01',
      'sort=title',
      'direction=up',
      'format=pdf',
      'columns=body',
      'ids=nope',
    ]) {
      const { response, upstream } = await get(`blog/admin/posts/export?${query}`);
      expect(response.status, query).toBe(400);
      expect(upstream, query).not.toHaveBeenCalled();
    }
  });

  it('relays 200 ids whole and refuses 201', async () => {
    const two = Array.from({ length: 200 }, () => ID).join(',');
    const ok = await get(`blog/admin/posts/export?ids=${two}`);
    expect(ok.response.status).toBe(200);
    expect(ok.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/blog/admin/posts/export?ids=${two.replaceAll(',', '%2C')}`,
    );
    const many = await get(`blog/admin/posts/export?ids=${two},${ID}`);
    expect(many.response.status).toBe(400);
    expect(many.upstream).not.toHaveBeenCalled();
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

  it('changes one page by its id or system key: settings, modules, order, restore, publish, archive', async () => {
    const slot = 'storefront/admin/pages';
    for (const [method, path] of [
      ['PUT', `${slot}/${id}`],
      ['PUT', `${slot}/home`],
      ['POST', `${slot}/${id}/slots/main/modules`],
      ['POST', `${slot}/offers/slots/top/modules`],
      ['PUT', `${slot}/${id}/slots/no-results/modules/${id}`],
      ['DELETE', `${slot}/${id}/slots/main/modules/${id}`],
      ['PUT', `${slot}/${id}/slots/main/order`],
      ['POST', `${slot}/${id}/restore`],
      ['POST', `${slot}/${id}/publish`],
      ['POST', `${slot}/${id}/archive`],
      ['POST', `${slot}/home/publish`],
    ] as const) {
      const ok = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), ok)).status).toBe(200);
      expect(ok.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
    }
  });

  it('changes the navigation: the draft, a restore and the approval, nothing else', async () => {
    const base = 'storefront/admin/navigation';
    for (const [method, path, status] of [
      ['PUT', `${base}/draft`, 200],
      ['POST', `${base}/restore`, 200],
      ['POST', `${base}/approve`, 200],
      ['GET', `${base}/draft`, 404],
      ['POST', `${base}/draft`, 404],
      ['PUT', `${base}/approve`, 404],
      ['DELETE', base, 404],
      ['PUT', base, 404],
      ['POST', `${base}/approve/extra`, 404],
    ] as const) {
      const upstream = upstreamOk();
      expect((await relay(config, request(method, path), path.split('/'), upstream)).status).toBe(
        status,
      );
      expect(upstream.mock.calls.length).toBe(status === 200 ? 1 : 0);
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
      // Restore, publish and archive are POST only, on one page, and take no further segment.
      ['PUT', `${base}/${id}/publish`],
      ['GET', `${base}/${id}/archive`],
      ['DELETE', `${base}/${id}/restore`],
      ['POST', `${base}/navigation/publish`],
      ['POST', `${base}/${id}/publish/extra`],
      ['POST', `${base}/${id}/slots/main/publish`],
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
    ['GET', 'wallet/admin/credit-requests/export'],
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
    ['POST', `blog/admin/posts/${id}/publish`],
    ['POST', `blog/admin/posts/${id}/pause`],
    ['POST', `blog/admin/posts/${id}/resume`],
    ['POST', `blog/admin/posts/${id}/archive`],
    ['PUT', `blog/admin/posts/${id}/schedule`],
    ['DELETE', `blog/admin/posts/${id}/schedule`],
    ['PUT', `blog/admin/posts/${id}/slug`],
    ['PUT', `blog/admin/posts/${id}/featured`],
    ['GET', 'blog/admin/taxonomy'],
    ['POST', 'blog/admin/taxonomy/categories'],
    ['PUT', `blog/admin/taxonomy/categories/${id}`],
    ['DELETE', `blog/admin/taxonomy/categories/${id}`],
    ['POST', 'blog/admin/taxonomy/tags'],
    ['DELETE', `blog/admin/taxonomy/tags/${id}`],
    ['GET', 'catalog/admin/brands'],
    ['GET', 'catalog/admin/brands/merge-queue'],
    ['GET', 'catalog/admin/brands/export'],
    ['POST', 'catalog/admin/brands'],
    ['PUT', `catalog/admin/brands/${id}`],
    ['POST', `catalog/admin/brands/${id}/approve`],
    ['POST', `catalog/admin/brands/${id}/archive`],
    ['POST', `catalog/admin/brands/${id}/merge`],
    ['POST', 'catalog/admin/brands/merge-queue/dismiss'],
    ['GET', 'catalog/admin/categories'],
    ['GET', `catalog/admin/categories/${id}`],
    ['GET', `catalog/admin/categories/${id}/impact`],
    ['GET', `catalog/admin/categories/${id}/move-products`],
    ['POST', `catalog/admin/categories/${id}/move-products`],
    ['GET', 'catalog/admin/platform-products/category-picker'],
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
    ['GET', 'catalog/admin/reports/products-missing-details/export'],
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

  it('refuses a malformed id search of the deletion request list instead of reading every request', async () => {
    const refused = await run('GET', 'customers/admin/deletion-requests?q=ada', readHeaders);
    expect(refused.response.status).toBe(400);
    expect(refused.upstream).not.toHaveBeenCalled();
  });

  it('passes the Account deletion requests super list query and its export only in the shapes the API takes', async () => {
    const listed = await run(
      'GET',
      `customers/admin/deletion-requests?view=cancelled&requestedBy=admin&cancelReason=sign-in&q=${id}&from=2026-11-01T00:00:00Z&scheduledBefore=2026-12-01T00:00:00Z&sort=cancelled&direction=asc&page=2&pageSize=25&ticket=x`,
      readHeaders,
    );
    expect(listed.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/customers/admin/deletion-requests?view=cancelled&requestedBy=admin&cancelReason=sign-in&q=${id}&from=2026-11-01T00%3A00%3A00Z&scheduledBefore=2026-12-01T00%3A00%3A00Z&sort=cancelled&direction=asc&page=2&pageSize=25`,
    );
    const dropped = await run(
      'GET',
      'customers/admin/deletion-requests?view=open&requestedBy=seller&sort=account&pageSize=500&from=2026-11-01',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/customers/admin/deletion-requests',
    );
    const file = await run(
      'GET',
      `customers/admin/deletion-requests/export?format=xlsx&columns=cancelled,completed&ids=${id}&view=all&page=2&reason=x`,
      readHeaders,
    );
    expect(file.response.status).toBe(200);
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/customers/admin/deletion-requests/export?format=xlsx&columns=cancelled%2Ccompleted&ids=${id}&view=all`,
    );
    const many = Array.from({ length: 200 }, () => id).join(',');
    const chosen = await run(
      'GET',
      `customers/admin/deletion-requests/export?ids=${many}`,
      readHeaders,
    );
    expect(chosen.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/customers/admin/deletion-requests/export?ids=${many.replaceAll(',', '%2C')}`,
    );
    // A malformed key refuses the file instead of widening it to the whole Market.
    const badFile = await run(
      'GET',
      'customers/admin/deletion-requests/export?format=pdf&columns=ticket&ids=x',
      readHeaders,
    );
    expect(badFile.response.status).toBe(400);
    expect(badFile.upstream).not.toHaveBeenCalled();
    const tooMany = await run(
      'GET',
      `customers/admin/deletion-requests/export?format=csv&ids=${Array.from({ length: 201 }, () => id).join(',')}`,
      readHeaders,
    );
    expect(tooMany.response.status).toBe(400);
    expect(tooMany.upstream).not.toHaveBeenCalled();
    for (const bad of ['q=ada', 'from=yesterday', 'view=open', 'requestedBy=seller']) {
      const refused = await run(
        'GET',
        `customers/admin/deletion-requests/export?format=csv&${bad}`,
        readHeaders,
      );
      expect(refused.response.status).toBe(400);
      expect(refused.upstream).not.toHaveBeenCalled();
    }
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

  it('passes the review queue list keys in their shapes, and drops the rest', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/review-queue?kind=product-revision&sellerId=${id}&firstPublication=false&hasImages=true&page=2&pageSize=25&paging=pages&sort=submitted&direction=desc&q=oil&x=1`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/review-queue?kind=product-revision&sellerId=${id}&firstPublication=false&hasImages=true&page=2&pageSize=25&paging=pages&sort=submitted&direction=desc`,
    );
    const bad = await run(
      'GET',
      'catalog/admin/review-queue?kind=offers&sellerId=nope&hasImages=false&page=0&sort=name&direction=up',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe('http://api.test/catalog/admin/review-queue');
  });

  it('passes the review queue export keys in their shapes, and never the sort or direction', async () => {
    const { upstream } = await run(
      'GET',
      `catalog/admin/review-queue/export?format=xlsx&kind=offer-first-publication&sellerId=${id}&firstPublication=true&hasImages=true&sort=submitted&direction=desc&q=oil`,
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/catalog/admin/review-queue/export?format=xlsx&kind=offer-first-publication&sellerId=${id}&firstPublication=true&hasImages=true`,
    );
    const bad = await run(
      'GET',
      'catalog/admin/review-queue/export?format=pdf&kind=offers&sellerId=nope&hasImages=false',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/review-queue/export',
    );
    const more = await run(
      'GET',
      'catalog/admin/review-queue/export?format=csv&kind=&sellerId=&firstPublication=false&page=1&pageSize=25&paging=pages',
      readHeaders,
    );
    expect(more.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/review-queue/export?format=csv&firstPublication=false',
    );
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

  it('passes the list keys of the value suggestions in their shapes, and drops the rest', async () => {
    const { upstream } = await run(
      'GET',
      'catalog/admin/attribute-suggestions?q=oat&page=2&pageSize=25&paging=pages&sort=created&direction=asc&x=1',
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/attribute-suggestions?q=oat&page=2&pageSize=25&paging=pages&sort=created&direction=asc',
    );
    const bad = await run(
      'GET',
      'catalog/admin/attribute-suggestions?page=0&paging=all&sort=label&direction=up',
      readHeaders,
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/attribute-suggestions',
    );
  });

  it('passes the page keys of the attribute list in their shapes', async () => {
    const { upstream } = await run(
      'GET',
      'catalog/admin/attributes?search=heat&page=2&pageSize=25&paging=pages&sort=type&direction=desc&q=x',
      readHeaders,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/catalog/admin/attributes?search=heat&page=2&pageSize=25&paging=pages&sort=type&direction=desc',
    );
    const bad = await run(
      'GET',
      'catalog/admin/attributes?page=0&pageSize=101&paging=all&sort=material&direction=up',
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

  it("passes the older queue's status, cursor and limit of the requests list, in their shapes", async () => {
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

  it('passes the Credit requests super list query and its export in shape, dropping the rest', async () => {
    const list = await run(
      'GET',
      `wallet/admin/credit-requests?view=all&status=expired&reason=promotion&approvalReason=daily-cap&q=${id}&requestedBy=me&from=2026-11-01T00:00:00Z&minAmount=100&sort=expires&direction=asc&page=2&pageSize=50&x=1`,
      readHeaders,
    );
    expect(list.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/wallet/admin/credit-requests?view=all&status=expired&reason=promotion&approvalReason=daily-cap&q=${id}&requestedBy=me&from=2026-11-01T00%3A00%3A00Z&minAmount=100&sort=expires&direction=asc&page=2&pageSize=50`,
    );
    const dropped = await run(
      'GET',
      'wallet/admin/credit-requests?view=mine&reason=gift&requestedBy=you&q=abc&sort=customer&pageSize=101&maxAmount=-1',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/wallet/admin/credit-requests',
    );
    const file = await run(
      'GET',
      `wallet/admin/credit-requests/export?format=xlsx&columns=note,journal&ids=${id}&view=decided&page=2&cursor=1.x`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/wallet/admin/credit-requests/export?format=xlsx&columns=note%2Cjournal&ids=${id}&view=decided`,
    );
    const badFile = await run(
      'GET',
      'wallet/admin/credit-requests/export?format=pdf&columns=fingerprint&ids=x',
      readHeaders,
    );
    // A malformed key refuses the file instead of widening it to the whole Market.
    expect(badFile.response.status).toBe(400);
    expect(badFile.upstream).not.toHaveBeenCalled();
    const tooMany = await run(
      'GET',
      `wallet/admin/credit-requests/export?format=csv&ids=${Array.from({ length: 201 }, () => id).join(',')}`,
      readHeaders,
    );
    expect(tooMany.response.status).toBe(400);
    expect(tooMany.upstream).not.toHaveBeenCalled();
    for (const bad of ['q=ada', 'from=yesterday']) {
      const refused = await run(
        'GET',
        `wallet/admin/credit-requests/export?format=csv&${bad}`,
        readHeaders,
      );
      expect(refused.response.status).toBe(400);
      expect(refused.upstream).not.toHaveBeenCalled();
    }
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

  it('passes the Disputes super list query and its export in shape, dropping the rest', async () => {
    const list = await run(
      'GET',
      `commission-payouts/admin/disputes?view=won&money=withdrawn&status=lost&q=${id}&search=alpha&sort=evidence-due&direction=asc&page=2&pageSize=50&dueBefore=2026-11-02T00:00:00Z&minAmount=100&x=1`,
      readHeaders,
    );
    expect(list.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/disputes?view=won&status=lost&money=withdrawn&q=${id}&search=alpha&dueBefore=2026-11-02T00%3A00%3A00Z&minAmount=100&sort=evidence-due&direction=asc&page=2&pageSize=50`,
    );
    const dropped = await run(
      'GET',
      'commission-payouts/admin/disputes?view=open&money=gone&sort=name&q=abc&minAmount=-1',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/commission-payouts/admin/disputes',
    );
    const file = await run(
      'GET',
      `commission-payouts/admin/disputes/export?format=xlsx&columns=reason,seller-ids&ids=${id}&view=closed&page=2&cursor=1.x`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/disputes/export?format=xlsx&columns=reason%2Cseller-ids&ids=${id}&view=closed`,
    );
    // A malformed narrowing key of the export refuses the file instead of widening it.
    const wide = await run(
      'GET',
      'commission-payouts/admin/disputes/export?format=csv&sellerId=nope',
      readHeaders,
    );
    expect(wide.response.status).toBe(400);
    expect(wide.upstream).not.toHaveBeenCalled();
  });

  it('passes the held-price super list query and its export in shape, dropping the rest', async () => {
    const list = await run(
      'GET',
      `pricing/admin/price-holds/list?view=up&kind=regular&q=${id}&sellerId=${id}&sort=amount&direction=desc&paging=prev-next&page=2&pageSize=50&from=2026-11-02T00:00:00Z&minAmount=100&x=1`,
      readHeaders,
    );
    expect(list.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/pricing/admin/price-holds/list?view=up&kind=regular&q=${id}&sellerId=${id}&from=2026-11-02T00%3A00%3A00Z&minAmount=100&sort=amount&direction=desc&paging=prev-next&page=2&pageSize=50`,
    );
    const dropped = await run(
      'GET',
      'pricing/admin/price-holds/list?view=open&change=sideways&sort=name&q=abc&minAmount=-1&paging=all',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/pricing/admin/price-holds/list',
    );
    const file = await run(
      'GET',
      `pricing/admin/price-holds/export?format=xlsx&columns=record-id,window&ids=${id}&view=down&page=2&paging=pages`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/pricing/admin/price-holds/export?format=xlsx&columns=record-id%2Cwindow&ids=${id}&view=down`,
    );
    expect((await run('POST', 'pricing/admin/price-holds/list')).response.status).toBe(404);
  });

  it('passes the certificate queue super list query and its export in shape, dropping the rest', async () => {
    const list = await run(
      'GET',
      `certification/admin/seller-certificates/list?view=renewal&kind=initial&type=halal&q=${id}&sellerId=${id}&sort=queue&direction=desc&paging=pages&page=2&pageSize=50&x=1`,
      readHeaders,
    );
    expect(list.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/certification/admin/seller-certificates/list?view=renewal&kind=initial&type=halal&q=${id}&sellerId=${id}&sort=queue&direction=desc&paging=pages&page=2&pageSize=50`,
    );
    const dropped = await run(
      'GET',
      'certification/admin/seller-certificates/list?view=done&type=Bad%20Code&sort=name&pageSize=500',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/certification/admin/seller-certificates/list',
    );
    const file = await run(
      'GET',
      `certification/admin/seller-certificates/export?format=xlsx&columns=certificate-id,seller-id&ids=${id}&page=2`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/certification/admin/seller-certificates/export?format=xlsx&columns=certificate-id%2Cseller-id&ids=${id}`,
    );
  });

  it('passes the "Needs a look" super list query and its export in shape, dropping the rest', async () => {
    const list = await run(
      'GET',
      `sellers/admin/health-queue/list?view=reports&metric=late-ready&q=al&sellerId=${id}&minScore=5&maxScore=100&sort=name&direction=desc&paging=pages&page=2&pageSize=50&x=1`,
      readHeaders,
    );
    expect(list.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/sellers/admin/health-queue/list?view=reports&metric=late-ready&q=al&sellerId=${id}&minScore=5&maxScore=100&sort=name&direction=desc&paging=pages&page=2&pageSize=50`,
    );
    const dropped = await run(
      'GET',
      'sellers/admin/health-queue/list?view=speed&metric=speed&q=a&minScore=101&sort=orders&pageSize=500',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/sellers/admin/health-queue/list',
    );
    const file = await run(
      'GET',
      `sellers/admin/health-queue/export?format=xlsx&columns=seller-id,day&ids=${id}&page=2`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/sellers/admin/health-queue/export?format=xlsx&columns=seller-id%2Cday&ids=${id}`,
    );
  });

  it('passes the issuer-request super list query and its export in shape, dropping the rest', async () => {
    const list = await run(
      'GET',
      `certification/admin/issuer-requests/list?view=all&type=halal&q=${id}&sellerId=${id}&sort=type&direction=desc&paging=prev-next&page=2&pageSize=50&x=1`,
      readHeaders,
    );
    expect(list.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/certification/admin/issuer-requests/list?view=all&type=halal&q=${id}&sellerId=${id}&sort=type&direction=desc&paging=prev-next&page=2&pageSize=50`,
    );
    const dropped = await run(
      'GET',
      'certification/admin/issuer-requests/list?view=open&type=Bad%20Code&q=abc&pageSize=500',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/certification/admin/issuer-requests/list',
    );
    const file = await run(
      'GET',
      `certification/admin/issuer-requests/export?format=xlsx&columns=request-id,documents&ids=${id}&page=2`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/certification/admin/issuer-requests/export?format=xlsx&columns=request-id%2Cdocuments&ids=${id}`,
    );
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
    // Every state of the list's Status filter crosses, the ones the All view shows too.
    for (const state of ['pending', 'voided', 'settled-by-netting']) {
      const other = await run(
        'GET',
        `commission-payouts/admin/payouts?status=${state}`,
        readHeaders,
      );
      expect(other.upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/commission-payouts/admin/payouts?status=${state}`,
      );
    }
    const exported = await run(
      'GET',
      'commission-payouts/admin/payouts/export?status=voided',
      readHeaders,
    );
    expect(exported.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/commission-payouts/admin/payouts/export?status=voided',
    );
  });

  it('passes the Payouts super list query and its export only in the shapes the API takes', async () => {
    const listed = await run(
      'GET',
      `commission-payouts/admin/payouts?view=sending&search=spice&sellerId=${id}&approvalMode=MANUAL&from=2026-11-01T00:00:00Z&minAmount=100&sort=amount&direction=asc&page=2&pageSize=25&x=1`,
      readHeaders,
    );
    expect(listed.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/payouts?view=sending&search=spice&sellerId=${id}&approvalMode=MANUAL&from=2026-11-01T00%3A00%3A00Z&minAmount=100&sort=amount&direction=asc&page=2&pageSize=25`,
    );
    const dropped = await run(
      'GET',
      'commission-payouts/admin/payouts?view=archived&q=nope&approvalMode=auto&minAmount=-1&sort=store&pageSize=500',
      readHeaders,
    );
    expect(dropped.upstream.mock.calls[0]?.[0]).toBe(
      'http://api.test/commission-payouts/admin/payouts',
    );
    const file = await run(
      'GET',
      `commission-payouts/admin/payouts/export?format=xlsx&columns=gross,outcome&ids=${id}&view=paid&page=2`,
      readHeaders,
    );
    expect(file.response.status).toBe(200);
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/payouts/export?format=xlsx&columns=gross%2Coutcome&ids=${id}&view=paid`,
    );
  });

  it('passes the Payouts Status and Amount filters of the list and of its strict export', async () => {
    const query = 'status=paid&minAmount=10000&maxAmount=500000';
    const listed = await run('GET', `commission-payouts/admin/payouts?${query}`, readHeaders);
    expect(listed.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/payouts?${query}`,
    );
    const file = await run(
      'GET',
      `commission-payouts/admin/payouts/export?format=csv&${query}`,
      readHeaders,
    );
    expect(file.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/payouts/export?format=csv&${query}`,
    );
    for (const bad of ['minAmount=1.5', 'maxAmount=-1', 'minAmount=abc', 'status=nope']) {
      const refused = await run(
        'GET',
        `commission-payouts/admin/payouts/export?format=csv&${bad}`,
        readHeaders,
      );
      expect([bad, refused.response.status]).toEqual([bad, 400]);
      expect(refused.upstream).not.toHaveBeenCalled();
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

  it('passes the note for reviewers of the two DELETEs that carry one, and only up to 500 characters', async () => {
    const note = encodeURIComponent('Back to default & done\nnext line');
    // The relay re-encodes the query, a space as "+", which the API reads as a space.
    const sent = 'Back+to+default+%26+done%0Anext+line';
    const rate = await run(
      'DELETE',
      `commission-payouts/admin/sellers/${id}/commission-rate?note=${note}&x=1`,
    );
    expect(rate.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/sellers/${id}/commission-rate?note=${sent}`,
    );
    const terms = await run(
      'DELETE',
      `commission-payouts/admin/sellers/${id}/payout-terms?expectedVersion=3&reasonCode=policy&note=${note}`,
    );
    expect(terms.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/sellers/${id}/payout-terms?expectedVersion=3&reasonCode=policy&note=${sent}`,
    );
    const long = await run(
      'DELETE',
      `commission-payouts/admin/sellers/${id}/commission-rate?note=${'a'.repeat(501)}`,
    );
    expect(long.upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/commission-payouts/admin/sellers/${id}/commission-rate`,
    );
  });

  it('relays the body of a write with a note unchanged', async () => {
    const body = JSON.stringify({ rateBps: 1200, note: 'Fee review' });
    const path = `commission-payouts/admin/sellers/${id}/commission-rate`;
    const upstream = upstreamOk();
    await relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, {
        method: 'PUT',
        headers: sameOrigin,
        body,
      }),
      path.split('/'),
      upstream,
    );
    expect(upstream.mock.calls[0]?.[1]?.body).toBe(body);
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

  describe('the order export', () => {
    const exportPath = ['ordering', 'admin', 'orders', 'export'];

    it('relays the list filter and drops paging, sort and a value of the wrong shape', async () => {
      const upstream = upstreamOk();
      await relay(
        config,
        get(
          `ordering/admin/orders/export?format=csv&status=confirmed&paymentState=captured&fulfilment=shipped&sellerId=${id}&from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z&page=2&pageSize=50&sort=total&limit=5&cursor=c1`,
        ),
        exportPath,
        upstream,
      );
      await relay(
        config,
        get('ordering/admin/orders/export?format=pdf&status=shipped&paymentState=free&from=today'),
        exportPath,
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/ordering/admin/orders/export?format=csv&status=confirmed&paymentState=captured&fulfilment=shipped&sellerId=${id}&from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z`,
      );
      expect(upstream.mock.calls[1]?.[0]).toBe('http://api.test/ordering/admin/orders/export');
    });

    it('does not relay the export as a write', async () => {
      const upstream = upstreamOk();
      expect(
        (
          await relay(
            config,
            post('ordering/admin/orders/export', sameOrigin, '{}'),
            exportPath,
            upstream,
          )
        ).status,
      ).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    });
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

describe('relay of the saved views of the Sales lists', () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  const request = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    });

  it.each(['shipments', 'refunds', 'documents'])(
    'relays the saved views of admin.ordering.%s with the list key only',
    async (name) => {
      const upstream = upstreamOk();
      await relay(
        config,
        request('GET', `lists/admin/saved-filters?listKey=admin.ordering.${name}&extra=1`),
        ['lists', 'admin', 'saved-filters'],
        upstream,
      );
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `http://api.test/lists/admin/saved-filters?listKey=admin.ordering.${name}`,
      );
    },
  );

  it('relays the saved views of the System requests queue, and its key on delete', async () => {
    const listed = upstreamOk();
    await relay(
      config,
      request('GET', 'lists/admin/saved-filters?listKey=admin.system-requests.requests&x=1'),
      ['lists', 'admin', 'saved-filters'],
      listed,
    );
    expect(listed.mock.calls[0]?.[0]).toBe(
      'http://api.test/lists/admin/saved-filters?listKey=admin.system-requests.requests',
    );
    const removed = upstreamOk();
    await relay(
      config,
      request('DELETE', `lists/admin/saved-filters/${id}?listKey=admin.system-requests.requests`),
      ['lists', 'admin', 'saved-filters', id],
      removed,
    );
    expect(removed.mock.calls[0]?.[0]).toBe(
      `http://api.test/lists/admin/saved-filters/${id}?listKey=admin.system-requests.requests`,
    );
  });

  it.each([
    'admin.certification.issuer-requests',
    'admin.certification.review-queue',
    'admin.sellers.health-queue',
    'admin.sellers.list',
  ])('relays the saved views of %s, and keeps its key on delete', async (listKey) => {
    const listed = upstreamOk();
    await relay(
      config,
      request('GET', `lists/admin/saved-filters?listKey=${listKey}&extra=1`),
      ['lists', 'admin', 'saved-filters'],
      listed,
    );
    expect(listed.mock.calls[0]?.[0]).toBe(
      `http://api.test/lists/admin/saved-filters?listKey=${listKey}`,
    );
    const removed = upstreamOk();
    await relay(
      config,
      request('DELETE', `lists/admin/saved-filters/${id}?listKey=${listKey}`),
      ['lists', 'admin', 'saved-filters', id],
      removed,
    );
    expect(removed.mock.calls[0]?.[0]).toBe(
      `http://api.test/lists/admin/saved-filters/${id}?listKey=${listKey}`,
    );
  });

  it.each([
    'admin.certification.issuers',
    'admin.sellers.lists',
    'admin.sellers.health-queue.x',
    'seller.sellers.list',
  ])('drops the list key %s, which is no list on the generic route', async (listKey) => {
    const upstream = upstreamOk();
    await relay(
      config,
      request('GET', `lists/admin/saved-filters?listKey=${listKey}`),
      ['lists', 'admin', 'saved-filters'],
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/lists/admin/saved-filters');
  });

  it('drops a list key that is not a Sales list', async () => {
    const upstream = upstreamOk();
    await relay(
      config,
      request('GET', 'lists/admin/saved-filters?listKey=admin.catalog.products'),
      ['lists', 'admin', 'saved-filters'],
      upstream,
    );
    expect(upstream.mock.calls[0]?.[0]).toBe('http://api.test/lists/admin/saved-filters');
  });

  it('relays create, reorder, rename and delete (the list key stays on delete)', async () => {
    for (const [method, path, expected] of [
      ['POST', 'lists/admin/saved-filters', 'lists/admin/saved-filters'],
      ['PUT', 'lists/admin/saved-filters/order', 'lists/admin/saved-filters/order'],
      ['PUT', `lists/admin/saved-filters/${id}`, `lists/admin/saved-filters/${id}`],
      [
        'DELETE',
        `lists/admin/saved-filters/${id}?listKey=admin.ordering.refunds&x=1`,
        `lists/admin/saved-filters/${id}?listKey=admin.ordering.refunds`,
      ],
    ] as const) {
      const ok = upstreamOk();
      const target = path.split('?')[0]!;
      expect((await relay(config, request(method, path), target.split('/'), ok)).status).toBe(200);
      expect(ok.mock.calls[0]?.[0]).toBe(`http://api.test/${expected}`);
    }
  });

  it('refuses a write from another origin', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      request('POST', 'lists/admin/saved-filters', {
        ...sameOrigin,
        origin: 'http://evil.test',
        'sec-fetch-site': 'cross-site',
      }),
      ['lists', 'admin', 'saved-filters'],
      upstream,
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses other methods and ids on the saved views', async () => {
    for (const [method, path] of [
      ['PUT', 'lists/admin/saved-filters'],
      ['DELETE', 'lists/admin/saved-filters'],
      ['PUT', 'lists/admin/saved-filters/not-a-uuid'],
      ['POST', `lists/admin/saved-filters/${id}`],
      ['GET', `lists/admin/saved-filters/${id}`],
      ['POST', 'lists/admin/saved-filters/order'],
    ] as const) {
      const fetchImpl = upstreamOk();
      const response = await relay(config, request(method, path), path.split('/'), fetchImpl);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
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

describe('relay of the System requests export', () => {
  const path = ['system-requests', 'admin', 'requests', 'export'];
  const base = 'http://api.test/system-requests/admin/requests/export';
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/system-requests/admin/requests/export${query}`, {
      method: 'GET',
      headers: sameOrigin,
    });
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');

  it('relays the list filter, its sort, the format, the columns, the ids and the zone, and drops paging', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        '?view=all-open&q=SR-12&area=money,people&risk=high&status=open&requestedBy=0190a000-0000-7000-8000-0000000000b1&appliedFrom=2026-11-01T00:00:00.000Z&appliedTo=2026-11-08T00:00:00.000Z&overdue=true&subjectKind=settings.market-setting&subjectRef=list-paging&sort=due&direction=asc&format=xlsx&columns=subject,comments&ids=' +
          ids(2) +
          '&zone=Australia/Brisbane&page=2&pageSize=25&cursor=abc&extra=1',
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    const url = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe(base);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: 'xlsx',
      columns: 'subject,comments',
      ids: ids(2),
      zone: 'Australia/Brisbane',
      view: 'all-open',
      q: 'SR-12',
      area: 'money,people',
      risk: 'high',
      status: 'open',
      requestedBy: '0190a000-0000-7000-8000-0000000000b1',
      appliedFrom: '2026-11-01T00:00:00.000Z',
      appliedTo: '2026-11-08T00:00:00.000Z',
      overdue: 'true',
      subjectKind: 'settings.market-setting',
      subjectRef: 'list-paging',
      sort: 'due',
      direction: 'asc',
    });
  });

  it('passes 100 ids and an empty column list', async () => {
    const upstream = upstreamOk();
    await relay(config, get(`?ids=${ids(100)}&columns=`), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `${base}?columns=&ids=${encodeURIComponent(ids(100))}`,
    );
  });

  it.each([
    ['101 ids', `?ids=${ids(101)}`],
    ['an empty ids', '?ids='],
    ['an id that is not a UUID', '?ids=not-an-id'],
    ['a column that is not allowed', '?columns=subject,before'],
    ['a format that is not allowed', '?format=xls'],
    ['a zone that is a path', '?zone=../etc'],
    // A malformed filter is refused rather than dropped: dropping it would widen the file.
    ['a view that is not one', '?view=everything'],
    ['a risk that is not one', '?risk=urgent'],
    ['an author that is not an id', '?requestedBy=me'],
    ['a repeated area', '?area=money&area=people'],
    ['an applied day without a time', '?appliedFrom=2026-11-01'],
  ])('answers 400 and calls nothing for %s', async (_name, query) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the shipments export', () => {
  const path = ['ordering', 'admin', 'shipments', 'export'];
  const base = 'http://api.test/ordering/admin/shipments/export';
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/shipments/export${query}`, {
      method: 'GET',
      headers: sameOrigin,
    });
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');

  it('relays the list filter, the format, the columns, the ids and the zone, and drops paging and sort', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        '?stage=shipped&attention=any&deliveryMethod=same_day&q=SC%204471&sellerId=0190a000-0000-7000-8000-0000000000b1&paidFrom=2026-11-01T00:00:00.000Z&paidTo=2026-11-08T00:00:00.000Z&shippedFrom=2026-11-02T00:00:00.000Z&shippedTo=2026-11-03T00:00:00.000Z&format=xlsx&columns=store,customer,sellerOrderId,shipping&ids=' +
          ids(2) +
          '&zone=Australia/Brisbane&page=2&pageSize=25&sort=total&direction=asc&limit=25&cursor=1763300000000.0190a000-0000-7000-8000-0000000000a1&extra=1',
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    const url = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe(base);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      stage: 'shipped',
      attention: 'any',
      deliveryMethod: 'same_day',
      q: 'SC 4471',
      sellerId: '0190a000-0000-7000-8000-0000000000b1',
      paidFrom: '2026-11-01T00:00:00.000Z',
      paidTo: '2026-11-08T00:00:00.000Z',
      shippedFrom: '2026-11-02T00:00:00.000Z',
      shippedTo: '2026-11-03T00:00:00.000Z',
      format: 'xlsx',
      columns: 'store,customer,sellerOrderId,shipping',
      ids: ids(2),
      zone: 'Australia/Brisbane',
    });
  });

  it('passes all 14 export column ids, in the order the list shows them', async () => {
    const upstream = upstreamOk();
    const all =
      'store,customer,paid,delivery,carrier,carrierProgress,total,ready,shipped,delivered,fleet,shipping,refunded,sellerOrderId';
    const response = await relay(config, get(`?columns=${all}`), path, upstream);
    expect(response.status).toBe(200);
    expect(new URL(upstream.mock.calls[0]?.[0] as string).searchParams.get('columns')).toBe(all);
  });

  it('passes 200 ids and an empty column list', async () => {
    const upstream = upstreamOk();
    await relay(config, get(`?ids=${ids(200)}&columns=`), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `${base}?columns=&ids=${encodeURIComponent(ids(200))}`,
    );
  });

  it.each([
    ['201 ids', `?ids=${ids(201)}`],
    ['an empty ids', '?ids='],
    ['an id that is not a UUID', '?ids=not-an-id'],
    ['a repeated ids', `?ids=${ids(1)}&ids=${ids(2)}`],
    ['a column that is not allowed', '?columns=store,secret'],
    ['a repeated column', `?columns=${Array(16).fill('store').join(',')}`],
    ['a format that is not allowed', '?format=xls'],
    ['an upper case format', '?format=CSV'],
    ['a zone that is a path', '?zone=../etc'],
    ['an empty zone', '?zone='],
    ['an oversized zone', `?zone=${'A'.repeat(600)}`],
  ])('answers 400 and calls nothing for %s', async (_name, query) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays a file byte for byte with its type and attachment name', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f]);
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': type,
            'content-disposition': 'attachment; filename="shipments-2026-11-16.xlsx"',
          },
        }),
      ),
    );
    const response = await relay(config, get('?format=xlsx'), path, upstream);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="shipments-2026-11-16.xlsx"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('relays the too-large refusal with its details', async () => {
    const body = JSON.stringify({
      statusCode: 413,
      code: 'batch.too-large',
      details: { max: 10000, total: 12000 },
    });
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(body, { status: 413, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const response = await relay(config, get('?format=csv'), path, upstream);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(body);
  });

  it('does not relay the export as a write', async () => {
    const upstream = upstreamOk();
    expect(
      (await relay(config, post('ordering/admin/shipments/export'), path, upstream)).status,
    ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the refunds export', () => {
  const path = ['ordering', 'admin', 'refunds', 'export'];
  const base = 'http://api.test/ordering/admin/refunds/export';
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/refunds/export${query}`, {
      method: 'GET',
      headers: sameOrigin,
    });
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');

  it('relays the list filter, the format, the columns, the ids and the zone, and drops paging and sort', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        '?state=succeeded&reason=damaged&actor=seller&lossBearer=platform&ledger=waiting&search=Ada&sellerId=0190a000-0000-7000-8000-0000000000b1&from=2026-11-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z&format=xlsx&columns=amount,store,lossBearer,creditNote&ids=' +
          ids(2) +
          '&zone=Australia/Brisbane&page=2&pageSize=25&sort=total&direction=asc&limit=25&cursor=1763300000000.0190a000-0000-7000-8000-0000000000a1&extra=1',
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    const url = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe(base);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: 'succeeded',
      reason: 'damaged',
      actor: 'seller',
      lossBearer: 'platform',
      ledger: 'waiting',
      search: 'Ada',
      sellerId: '0190a000-0000-7000-8000-0000000000b1',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-08T00:00:00.000Z',
      format: 'xlsx',
      columns: 'amount,store,lossBearer,creditNote',
      ids: ids(2),
      zone: 'Australia/Brisbane',
    });
  });

  it('passes 200 ids and an empty column list', async () => {
    const upstream = upstreamOk();
    await relay(config, get(`?ids=${ids(200)}&columns=`), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `${base}?columns=&ids=${encodeURIComponent(ids(200))}`,
    );
  });

  it.each([
    ['201 ids', `?ids=${ids(201)}`],
    ['an empty ids', '?ids='],
    ['an id that is not a UUID', '?ids=not-an-id'],
    ['a repeated ids', `?ids=${ids(1)}&ids=${ids(2)}`],
    ['a column that is not allowed', '?columns=store,secret'],
    ['a repeated column', `?columns=${Array(16).fill('store').join(',')}`],
    ['a format that is not allowed', '?format=xls'],
    ['an upper case format', '?format=CSV'],
    ['a zone that is a path', '?zone=../etc'],
    ['an empty zone', '?zone='],
    ['an oversized zone', `?zone=${'A'.repeat(600)}`],
  ])('answers 400 and calls nothing for %s', async (_name, query) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays a file byte for byte with its type and attachment name', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f]);
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': type,
            'content-disposition': 'attachment; filename="refunds-2026-11-16.xlsx"',
          },
        }),
      ),
    );
    const response = await relay(config, get('?format=xlsx'), path, upstream);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="refunds-2026-11-16.xlsx"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('relays the too-large refusal with its details', async () => {
    const body = JSON.stringify({
      statusCode: 413,
      code: 'batch.too-large',
      details: { max: 10000, total: 12000 },
    });
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(body, { status: 413, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const response = await relay(config, get('?format=csv'), path, upstream);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(body);
  });

  it('does not relay the export as a write', async () => {
    const upstream = upstreamOk();
    expect(
      (await relay(config, post('ordering/admin/refunds/export'), path, upstream)).status,
    ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the invoices export', () => {
  const path = ['ordering', 'admin', 'documents', 'export'];
  const base = 'http://api.test/ordering/admin/documents/export';
  const get = (query: string) =>
    new Request(`http://admin.localhost:3002/api/ordering/admin/documents/export${query}`, {
      method: 'GET',
      headers: sameOrigin,
    });
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');

  it('relays the list filter, the format, the columns, the ids and the zone, and drops paging and sort', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        '?kind=credit-note&q=Ada&sellerId=0190a000-0000-7000-8000-0000000000b1&from=2026-11-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z&format=xlsx&columns=documentId,store,total,reason&ids=' +
          ids(2) +
          '&zone=Australia/Brisbane&page=2&pageSize=25&sort=total&direction=asc&limit=25&cursor=1763300000000.0190a000-0000-7000-8000-0000000000a1&extra=1',
      ),
      path,
      upstream,
    );
    expect(response.status).toBe(200);
    const url = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe(base);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'credit-note',
      q: 'Ada',
      sellerId: '0190a000-0000-7000-8000-0000000000b1',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-08T00:00:00.000Z',
      format: 'xlsx',
      columns: 'documentId,store,total,reason',
      ids: ids(2),
      zone: 'Australia/Brisbane',
    });
  });

  it('passes 200 ids and an empty column list', async () => {
    const upstream = upstreamOk();
    await relay(config, get(`?ids=${ids(200)}&columns=`), path, upstream);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `${base}?columns=&ids=${encodeURIComponent(ids(200))}`,
    );
  });

  it.each([
    ['201 ids', `?ids=${ids(201)}`],
    ['an empty ids', '?ids='],
    ['an id that is not a UUID', '?ids=not-an-id'],
    ['a repeated ids', `?ids=${ids(1)}&ids=${ids(2)}`],
    ['a column that is not allowed', '?columns=store,secret'],
    ['a repeated column', `?columns=${Array(16).fill('store').join(',')}`],
    ['a kind that is not allowed', '?kind=invoice'],
    ['an empty kind', '?kind='],
    ['a format that is not allowed', '?format=xls'],
    ['an upper case format', '?format=CSV'],
    ['a zone that is a path', '?zone=../etc'],
    ['an empty zone', '?zone='],
    ['an oversized zone', `?zone=${'A'.repeat(600)}`],
  ])('answers 400 and calls nothing for %s', async (_name, query) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(query), path, upstream);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays a file byte for byte with its type and attachment name', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f]);
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': type,
            'content-disposition': 'attachment; filename="credit-notes-2026-11-16.xlsx"',
          },
        }),
      ),
    );
    const response = await relay(config, get('?format=xlsx'), path, upstream);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="credit-notes-2026-11-16.xlsx"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('relays the too-large refusal with its details', async () => {
    const body = JSON.stringify({
      statusCode: 413,
      code: 'batch.too-large',
      details: { max: 10000, total: 12000 },
    });
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(body, { status: 413, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const response = await relay(config, get('?format=csv'), path, upstream);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(body);
  });

  it('does not relay the export as a write', async () => {
    const upstream = upstreamOk();
    expect(
      (await relay(config, post('ordering/admin/documents/export'), path, upstream)).status,
    ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('relay of the security alert super list', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = async (path: string) => {
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const response = await relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin }),
      path.split('?')[0]!.split('/'),
      upstream,
    );
    return { response, url: upstream.mock.calls[0]?.[0] as string | undefined };
  };

  it('passes the list keys of its own and drops the rest', async () => {
    const { url } = await get(
      'security/admin/alerts/list?view=critical&severity=s1,s2&rule=sign-in-failures-ip&keyType=ip&keyValue=203.0.113.7&minEvents=5&sort=events&direction=asc&paging=prev-next&page=2&pageSize=50&x=1',
    );
    expect(url).toBe(
      'http://api.test/security/admin/alerts/list?view=critical&severity=s1%2Cs2&rule=sign-in-failures-ip&keyType=ip&keyValue=203.0.113.7&minEvents=5&sort=events&direction=asc&paging=prev-next&page=2&pageSize=50',
    );
    const bad = await get('security/admin/alerts/list?view=other&minEvents=0&pageSize=500');
    expect(bad.url).toBe('http://api.test/security/admin/alerts/list');
  });

  it('refuses a malformed issuer-request export filter or 201 ids instead of widening the file', async () => {
    const many = Array.from({ length: 201 }, () => ID).join(',');
    for (const query of [
      `ids=${many}`,
      'sellerId=nope',
      'sellerId=',
      'q=nope',
      'type=Not%20A%20Code',
      'view=other',
      'from=2026-13',
      'to=x',
      'sort=x',
      'direction=up',
      'format=pdf',
      'columns=secret',
    ]) {
      const prefix = query.startsWith('format=') ? '' : 'format=csv&';
      const bad = await get(`certification/admin/issuer-requests/export?${prefix}${query}`);
      expect([query.slice(0, 20), bad.response.status]).toEqual([query.slice(0, 20), 400]);
      expect(bad.url).toBeUndefined();
    }
    const ids = Array.from({ length: 200 }, () => ID).join(',');
    const { url } = await get(`certification/admin/issuer-requests/export?format=csv&ids=${ids}`);
    expect(url).toContain(`ids=${encodeURIComponent(ids)}`);
    // No optional column shown: the empty list goes through (the file has its fixed columns).
    const none = await get(
      `certification/admin/issuer-requests/export?format=csv&columns=&ids=${ID}`,
    );
    expect(none.response.status).not.toBe(400);
    expect(none.url).toContain('columns=');
  });

  it('keeps the single-alert route apart from the list and the export', async () => {
    const one = await get(`security/admin/alerts/${ID}`);
    expect(one.response.status).toBe(404);
  });

  it('relays 200 selected ids whole and refuses a malformed filter instead of widening the file', async () => {
    const ids = Array.from({ length: 200 }, () => ID).join(',');
    const { url } = await get(`security/admin/alerts/export?format=csv&ids=${ids}`);
    expect(url).toContain(`ids=${encodeURIComponent(ids)}`);
    const bad = await get('security/admin/alerts/export?format=csv&view=other');
    expect(bad.response.status).toBe(400);
    expect(bad.url).toBeUndefined();
  });

  it('refuses a malformed certificate-queue export filter or 201 ids instead of widening the file', async () => {
    const many = Array.from({ length: 201 }, () => ID).join(',');
    for (const query of [
      `ids=${many}`,
      'sellerId=nope',
      'q=nope',
      'type=Not%20A%20Code',
      'view=other',
      'kind=other',
      'sellerId=',
      'from=2026-13',
      'to=x',
      'sort=x',
      'direction=up',
    ]) {
      const bad = await get(`certification/admin/seller-certificates/export?format=csv&${query}`);
      expect([query.slice(0, 20), bad.response.status]).toEqual([query.slice(0, 20), 400]);
      expect(bad.url).toBeUndefined();
    }
    for (const query of ['format=pdf', 'format=csv&columns=secret']) {
      const bad = await get(`certification/admin/seller-certificates/export?${query}`);
      expect([query, bad.response.status]).toEqual([query, 400]);
      expect(bad.url).toBeUndefined();
    }
    const ids = Array.from({ length: 200 }, () => ID).join(',');
    const { url } = await get(
      `certification/admin/seller-certificates/export?format=csv&ids=${ids}`,
    );
    expect(url).toContain(`ids=${encodeURIComponent(ids)}`);
  });
});

describe('relay of the review moderation super list', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = async (path: string) => {
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const response = await relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin }),
      path.split('?')[0]!.split('/'),
      upstream,
    );
    return { response, url: upstream.mock.calls[0]?.[0] as string | undefined };
  };

  it('passes the list keys of its own and drops the rest', async () => {
    const { url } = await get(
      `reviews/admin/moderation/list?view=reported&minRating=2&sellerId=${ID}&reportReason=abusive&sort=rating&direction=asc&paging=prev-next&page=2&pageSize=50&x=1`,
    );
    expect(url).toBe(
      `http://api.test/reviews/admin/moderation/list?view=reported&minRating=2&sellerId=${ID}&reportReason=abusive&sort=rating&direction=asc&paging=prev-next&page=2&pageSize=50`,
    );
    const bad = await get('reviews/admin/moderation/list?view=other&minRating=9&pageSize=500');
    expect(bad.url).toBe('http://api.test/reviews/admin/moderation/list');
  });

  it('passes the export keys and keeps the single-review route apart', async () => {
    const { url } = await get(
      `reviews/admin/moderation/export?format=xlsx&columns=review-id,signals&ids=${ID}&view=held&x=1`,
    );
    expect(url).toBe(
      `http://api.test/reviews/admin/moderation/export?format=xlsx&columns=review-id%2Csignals&ids=${ID}&view=held`,
    );
    const one = await get(`reviews/admin/moderation/${ID}`);
    expect(one.url).toBe(`http://api.test/reviews/admin/moderation/${ID}`);
  });

  it('relays 200 selected ids whole and refuses a malformed filter instead of widening the file', async () => {
    const ids = Array.from({ length: 200 }, () => ID).join(',');
    const { url } = await get(`reviews/admin/moderation/export?format=csv&ids=${ids}`);
    expect(url).toContain(`ids=${encodeURIComponent(ids)}`);
    const bad = await get(`reviews/admin/moderation/export?format=csv&view=other`);
    expect(bad.response.status).toBe(400);
    expect(bad.url).toBeUndefined();
  });
});

describe('relay of the phase 4 money and account exports (strict queries)', () => {
  const ID = '0190a000-0000-7000-8000-0000000000a1';
  const get = async (path: string) => {
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const response = await relay(
      config,
      new Request(`http://admin.localhost:3002/api/${path}`, { headers: sameOrigin }),
      path.split('?')[0]!.split('/'),
      upstream,
    );
    return { response, url: upstream.mock.calls[0]?.[0] as string | undefined };
  };

  it.each([
    'commission-payouts/admin/payouts/export',
    'commission-payouts/admin/disputes/export',
    'wallet/admin/credit-requests/export',
    'customers/admin/deletion-requests/export',
    'blog/admin/posts/export',
  ])(
    '%s relays 200 ids whole and refuses a malformed value instead of widening the file',
    async (target) => {
      const ids = Array.from({ length: 200 }, () => ID).join(',');
      const { url } = await get(`${target}?format=csv&ids=${ids}`);
      expect(url).toContain(`ids=${encodeURIComponent(ids)}`);

      const tooMany = Array.from({ length: 201 }, () => ID).join(',');
      for (const query of [
        'format=csv&ids=x',
        `format=csv&ids=${tooMany}`,
        'format=csv&status=bogus',
        'format=pdf',
      ]) {
        const bad = await get(`${target}?${query}`);
        expect([query, bad.response.status]).toEqual([query, 400]);
        expect(await bad.response.json()).toMatchObject({ code: 'validation.failed' });
        expect(bad.url).toBeUndefined();
      }
    },
  );

  it.each([
    'commission-payouts/admin/sellers/:id/ledger/export',
    'commission-payouts/admin/sellers/:id/payout-holds/export',
  ])('%s (a seller page export) is strict by its template', async (template) => {
    const SELLER = '0190a000-0000-7000-8000-0000000000b2';
    const target = template.replace(':id', SELLER);
    const ids = Array.from({ length: 200 }, () => ID).join(',');
    const sort = template.includes('ledger') ? 'occurred' : 'placed';
    const { url } = await get(`${target}?format=csv&ids=${ids}&sort=${sort}`);
    expect(url).toContain(`/${SELLER}/`);
    expect(url).toContain(`ids=${encodeURIComponent(ids)}`);

    const tooMany = Array.from({ length: 201 }, () => ID).join(',');
    for (const query of [
      'format=csv&ids=x',
      `format=csv&ids=${tooMany}`,
      'format=csv&sort=bogus',
      'format=pdf',
    ]) {
      const bad = await get(`${target}?${query}`);
      expect([query, bad.response.status]).toEqual([query, 400]);
      expect(bad.url).toBeUndefined();
    }
  });

  it('refuses a Credit requests export by an unknown requester instead of dropping the filter', async () => {
    const bad = await get('wallet/admin/credit-requests/export?format=csv&requestedBy=ME');
    expect(bad.response.status).toBe(400);
    expect(bad.url).toBeUndefined();
  });
});
