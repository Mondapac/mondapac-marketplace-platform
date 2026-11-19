import { describe, expect, it, vi } from 'vitest';
import { relay } from './bff.ts';
import type { PanelConfig } from './config.ts';

const config: PanelConfig = {
  apiBaseUrl: 'http://api.test',
  hosts: [
    { origin: 'http://seller.localhost:3001', host: 'seller.localhost:3001', marketId: 'AU' },
    { origin: 'http://seller-nz.localhost:3001', host: 'seller-nz.localhost:3001', marketId: 'NZ' },
  ],
  passwordMinLength: 15,
  passwordMaxLength: 128,
  marketName: 'Australia',
  locale: 'en-AU',
  supportEmail: 'support@example.com',
  storefrontAddress: null,
  storefrontOrigin: null,
  clientAddressKey: null,
};

const sameOrigin = {
  host: 'seller.localhost:3001',
  origin: 'http://seller.localhost:3001',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};
const ID = '0b6f0d3e-1c2a-4f7e-9a10-5d6b7c8e9f01';
const upstreamOk = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
const send = (method: string, path: string, headers: Record<string, string> = sameOrigin) =>
  new Request(`http://seller.localhost:3001/api/${path}`, {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: '{}' }),
  });

describe('relay allowlist for customers and exclusive perks', () => {
  it.each([
    'customers/seller/customers/list',
    'customers/seller/customers/export',
    'customers/seller/invite-link/refresh',
    'promotions/seller/promotions',
    `promotions/seller/promotions/${ID}/pause`,
    `promotions/seller/promotions/${ID}/resume`,
  ])('relays POST %s, same-origin only', async (path) => {
    const upstream = upstreamOk();
    expect((await relay(config, send('POST', path), path.split('/'), upstream)).status).toBe(200);
    const cross = await relay(
      config,
      send('POST', path, { ...sameOrigin, 'sec-fetch-site': 'cross-site' }),
      path.split('/'),
      upstream,
    );
    expect(cross.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('refuses the customers routes the panel does not use', async () => {
    const upstream = upstreamOk();
    for (const path of [
      'customers/seller/customers/list/codes',
      'customers/admin/customers/list',
    ]) {
      expect((await relay(config, send('POST', path), path.split('/'), upstream)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays the invite link and the promotion list as GET, and an edit as PATCH', async () => {
    const upstream = upstreamOk();
    for (const path of ['customers/seller/invite-link', 'promotions/seller/promotions']) {
      expect((await relay(config, send('GET', path), path.split('/'), upstream)).status).toBe(200);
    }
    const edit = `promotions/seller/promotions/${ID}`;
    expect((await relay(config, send('PATCH', edit), edit.split('/'), upstream)).status).toBe(200);
    const bad = 'promotions/seller/promotions/not-an-id';
    expect((await relay(config, send('PATCH', bad), bad.split('/'), upstream)).status).toBe(404);
  });

  it('relays the exclusive commission as GET only, with no query key', async () => {
    const upstream = upstreamOk();
    const path = 'commission-payouts/seller/exclusive-commission';
    expect(
      (await relay(config, send('GET', `${path}?months=3&x=1`), path.split('/'), upstream)).status,
    ).toBe(200);
    expect(String(upstream.mock.calls[0]?.[0] as string)).toBe(`http://api.test/${path}`);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect((await relay(config, send(method, path), path.split('/'), upstream)).status).toBe(404);
    }
    const deeper = `${path}/extra`;
    expect((await relay(config, send('GET', deeper), deeper.split('/'), upstream)).status).toBe(
      404,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('relays one customer by code with only page and pageSize, and refuses a bad code', async () => {
    const upstream = upstreamOk();
    const path = 'customers/seller/customers/AB12-CD34';
    const request = send('GET', `${path}?page=2&pageSize=25&x=1`);
    expect((await relay(config, request, path.split('/'), upstream)).status).toBe(200);
    expect(String(upstream.mock.calls[0]?.[0] as string)).toBe(
      `http://api.test/${path}?page=2&pageSize=25`,
    );
    const bad = ['customers', 'seller', 'customers', '../admin'];
    expect((await relay(config, send('GET', bad.join('/')), bad, upstream)).status).toBe(404);
  });

  it('sends the Market of the host (a second Market too)', async () => {
    const upstream = upstreamOk();
    const path = 'customers/seller/invite-link';
    const request = new Request(`http://seller-nz.localhost:3001/api/${path}`, {
      headers: { host: 'seller-nz.localhost:3001' },
    });
    await relay(config, request, path.split('/'), upstream);
    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-market-id')).toBe('NZ');
  });

  it('passes only type=CUSTOMER_GROUP or CASHBACK and limit on the promotion list', async () => {
    const upstream = upstreamOk();
    const path = 'promotions/seller/promotions';
    await relay(
      config,
      send('GET', `${path}?type=CUSTOMER_GROUP&limit=100&x=1`),
      path.split('/'),
      upstream,
    );
    await relay(config, send('GET', `${path}?type=REFERRAL`), path.split('/'), upstream);
    await relay(
      config,
      send('GET', `${path}?type=CASHBACK&limit=100&x=1`),
      path.split('/'),
      upstream,
    );
    await relay(config, send('GET', `${path}?type=CASHBACK,REFERRAL`), path.split('/'), upstream);
    expect(String(upstream.mock.calls[0]?.[0] as string)).toBe(
      `http://api.test/${path}?type=CUSTOMER_GROUP&limit=100`,
    );
    expect(String(upstream.mock.calls[1]?.[0] as string)).toBe(`http://api.test/${path}`);
    expect(String(upstream.mock.calls[2]?.[0] as string)).toBe(
      `http://api.test/${path}?type=CASHBACK&limit=100`,
    );
    expect(String(upstream.mock.calls[3]?.[0] as string)).toBe(`http://api.test/${path}`);
  });
});
