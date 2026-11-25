import { describe, expect, it, vi } from 'vitest';
import { relay } from './bff.ts';
import type { PanelConfig } from './config.ts';

// QA (PR 1334): the relay of "Add offer": the search path is a GET allowlist entry with a closed
// query, and a draft Offer is created through the POST allowlist only.

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
  storefrontOrigin: null,
  clientAddressKey: null,
};

const upstreamOk = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"items":[]}', { status: 200 })));
const search = ['catalog', 'seller', 'products', 'platform-search'];
const get = (query: string) =>
  new Request(`http://seller.localhost:3001/api/catalog/seller/products/platform-search${query}`, {
    method: 'GET',
    headers: { host: 'seller.localhost:3001' },
  });

describe('relay of the platform product search', () => {
  it('forwards q, barcodes and page, and drops every other key', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      get(
        '?q=beef&barcodes=4006381333931,96385074&page=2&notSelling=true&sellerId=other&marketId=ZZ&x=1',
      ),
      search,
      upstream,
    );
    expect(response.status).toBe(200);
    const sent = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(sent.pathname).toBe('/catalog/seller/products/platform-search');
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      q: 'beef',
      barcodes: '4006381333931,96385074',
      page: '2',
      notSelling: 'true',
    });
  });

  it.each([
    ['page=abc'],
    ['page=1234'],
    ['notSelling=yes'],
    ['barcodes=%3Cscript%3E'],
    [`barcodes=${'1'.repeat(4001)}`],
  ])('does not forward a value of the wrong shape (%s)', async (query) => {
    const upstream = upstreamOk();
    const response = await relay(config, get(`?${query}`), search, upstream);
    const sent = upstream.mock.calls[0]?.[0];
    if (sent === undefined) expect(response.status).toBeGreaterThanOrEqual(400);
    else expect(new URL(sent as string).search).toBe('');
  });

  it('refuses a method other than GET on the search path', async () => {
    const upstream = upstreamOk();
    const response = await relay(
      config,
      new Request('http://seller.localhost:3001/api/catalog/seller/products/platform-search', {
        method: 'POST',
        headers: {
          host: 'seller.localhost:3001',
          origin: 'http://seller.localhost:3001',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      search,
      upstream,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('does not open a sibling path under platform-search', async () => {
    const upstream = upstreamOk();
    const response = await relay(config, get(''), [...search, 'anything'], upstream);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
