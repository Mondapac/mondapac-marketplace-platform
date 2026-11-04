import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { relay } from './bff.ts';
import type { PanelConfig } from './config.ts';

// The browser code of the wallet pages and the step-up dialog calls the relay with literal
// paths. This reads those calls from the source and sends each through the real relay, so a route
// the client uses but the allowlist lacks fails here (the relay answers 404 for it).
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
const ID = '0190a000-0000-7000-8000-000000000001';
const src = path.join(import.meta.dirname, '..');
const files = [
  ...readdirSync(path.join(src, 'wallet'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'wallet', name)),
  ...readdirSync(path.join(src, 'disputes'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'disputes', name)),
  ...readdirSync(path.join(src, 'reviews'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'reviews', name)),
  ...readdirSync(path.join(src, 'payouts'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'payouts', name)),
  ...readdirSync(path.join(src, 'account-deletion'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'account-deletion', name)),
  path.join(src, 'step-up', 'step-up.tsx'),
];
const CALL = /(?:callApi|guarded)(?:<[^>]*>)?\(\s*'(GET|PUT|POST|DELETE)',\s*(['`])([^'`]+)\2/g;

function calls(): { method: string; target: string }[] {
  const found: { method: string; target: string }[] = [];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(CALL)) {
      const method = match[1]!;
      const template = (match[3] ?? '').split('?')[0]!;
      // `${kind}` is approve or reject; any other placeholder is an id.
      // `${action}` is one of the five buyer-review moderation actions.
      const variants = template.includes('${kind}')
        ? ['approve', 'reject'].map((kind) => template.replace('${kind}', kind))
        : template.includes('${action}')
          ? ['publish', 'hide', 'restore', 'remove', 'dismiss-reports'].map((action) =>
              template.replace('${action}', action),
            )
          : [template];
      for (const variant of variants) {
        found.push({
          method,
          target: variant.replace(/\$\{encodeURIComponent\([^}]*\)\}|\$\{[^}]*\}/g, ID),
        });
      }
    }
  }
  return found;
}

describe('every path the wallet, dispute, review moderation, account deletion and step-up client code calls passes the relay allowlist', () => {
  const found = calls();

  it('finds the calls it is meant to check', () => {
    const keys = found.map((call) => `${call.method} ${call.target.replaceAll(ID, ':id')}`);
    expect(new Set(keys)).toEqual(
      new Set([
        'GET wallet/admin/settings',
        'PUT wallet/admin/settings',
        'GET wallet/admin/customers/:id',
        'POST wallet/admin/credits',
        'GET wallet/admin/credit-requests',
        'POST wallet/admin/credit-requests/:id/approve',
        'POST wallet/admin/credit-requests/:id/reject',
        'GET commission-payouts/admin/disputes',
        'GET reviews/admin/moderation',
        'GET reviews/admin/moderation/:id',
        'POST reviews/admin/moderation/:id/publish',
        'POST reviews/admin/moderation/:id/hide',
        'POST reviews/admin/moderation/:id/restore',
        'POST reviews/admin/moderation/:id/remove',
        'POST reviews/admin/moderation/:id/dismiss-reports',
        'GET commission-payouts/admin/disputes/:id',
        'POST commission-payouts/admin/disputes/:id/seller-orders/:id/decision',
        'GET commission-payouts/admin/payouts',
        'GET commission-payouts/admin/payouts/:id',
        'POST commission-payouts/admin/payouts/:id/approve',
        'GET commission-payouts/admin/sellers/:id/payout-terms',
        'PUT commission-payouts/admin/sellers/:id/payout-terms',
        'DELETE commission-payouts/admin/sellers/:id/payout-terms',
        'GET commission-payouts/admin/sellers/:id/payout-holds',
        'POST commission-payouts/admin/sellers/:id/payout-holds',
        'POST commission-payouts/admin/payout-holds/:id/release',
        'POST identity/admin/step-up/verify',
        'GET customers/admin/account-deletion-settings',
        'PUT customers/admin/account-deletion-settings',
        'GET customers/admin/deletion-requests',
        'DELETE customers/admin/deletion-requests/:id',
        'POST customers/admin/buyers/:id/deletion-requests',
      ]),
    );
  });

  it.each(found.map((call) => [call.method, call.target] as const))(
    '%s %s is relayed, not refused as unknown',
    async (method, target) => {
      const upstream = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
      );
      const request = new Request(`http://admin.localhost:3002/api/${target}`, {
        method,
        headers: {
          host: 'admin.localhost:3002',
          origin: 'http://admin.localhost:3002',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      const response = await relay(config, request, target.split('/'), upstream);
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
    },
  );
});
