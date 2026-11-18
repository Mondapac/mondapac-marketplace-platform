import { describe, expect, it, vi } from 'vitest';
import { relay } from './bff.ts';
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
const id = '0190a000-0000-7000-8000-000000000001';
const upstreamOk = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
const send = (method: string, path: string) => {
  const upstream = upstreamOk();
  const url = path.split('?')[0] ?? path;
  return relay(
    config,
    new Request(`http://admin.localhost:3002/api/${path}`, {
      method,
      headers: sameOrigin,
      ...(method === 'GET' ? {} : { body: '{}' }),
    }),
    url.split('/'),
    upstream,
  ).then((response) => ({ response, upstream }));
};

describe('relay of the System requests routes', () => {
  it.each([
    ['GET', 'system-requests/admin/requests'],
    ['GET', 'system-requests/admin/requests-count'],
    ['GET', 'system-requests/admin/review-policy'],
    ['GET', `system-requests/admin/requests/${id}`],
    ['POST', 'system-requests/admin/requests/bulk-approve'],
    ['POST', 'system-requests/admin/requests/bulk-approve-matching'],
    ['POST', `system-requests/admin/requests/${id}/comments`],
    ['POST', `system-requests/admin/requests/${id}/approve`],
    ['POST', `system-requests/admin/requests/${id}/reject`],
    ['POST', `system-requests/admin/requests/${id}/withdraw`],
    ['PUT', 'system-requests/admin/review-policy/areas/money'],
    ['PUT', 'system-requests/admin/review-policy/areas/certification'],
    ['PUT', 'system-requests/admin/review-policy/review-due-days'],
  ])('relays %s %s', async (method, path) => {
    const { response, upstream } = await send(method, path);
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/${path}`);
  });

  it.each([
    ['DELETE', `system-requests/admin/requests/${id}`],
    ['PUT', `system-requests/admin/requests/${id}`],
    ['POST', 'system-requests/admin/requests'],
    ['POST', 'system-requests/admin/requests/not-a-uuid/approve'],
    ['POST', `system-requests/admin/requests/${id}/delete`],
    ['PUT', 'system-requests/admin/review-policy/areas/review-policy'],
    ['PUT', 'system-requests/admin/review-policy/areas/unknown'],
    ['PUT', 'system-requests/admin/review-policy'],
    ['GET', 'system-requests/admin/requests/bulk-approve'],
  ])('refuses %s %s', async (method, path) => {
    const { response, upstream } = await send(method, path);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps only the list keys, and only values of the right shape', async () => {
    const { upstream } = await send(
      'GET',
      'system-requests/admin/requests?view=mine&q=SR-1042&area=money,people&risk=high&status=open' +
        '&overdue=true&sort=due&direction=asc&page=2&pageSize=50&evil=1&view2=x',
    );
    const url = new URL(upstream.mock.calls[0]?.[0] as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: 'mine',
      q: 'SR-1042',
      area: 'money,people',
      risk: 'high',
      status: 'open',
      overdue: 'true',
      sort: 'due',
      direction: 'asc',
      page: '2',
      pageSize: '50',
    });
    const bad = await send(
      'GET',
      'system-requests/admin/requests?view=nope&risk=extreme&pageSize=1000&requestedBy=x&cursor=a%20b',
    );
    expect(bad.upstream.mock.calls[0]?.[0]).toBe('http://api.test/system-requests/admin/requests');
  });
});
