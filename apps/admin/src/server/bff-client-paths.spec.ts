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
  // The Blog posts list (its other folders call the editor and review routes).
  ...readdirSync(path.join(src, 'blog'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'blog', name)),
  ...readdirSync(path.join(src, 'orders'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'orders', name)),
  ...readdirSync(path.join(src, 'customers'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'customers', name)),
  // The helper the three Sales lists share (their saved filters).
  ...readdirSync(path.join(src, 'sales'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'sales', name)),
  ...readdirSync(path.join(src, 'sales', 'shipments'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'sales', 'shipments', name)),
  ...readdirSync(path.join(src, 'sales', 'refunds'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'sales', 'refunds', name)),
  ...readdirSync(path.join(src, 'sales', 'invoices'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'sales', 'invoices', name)),
  ...readdirSync(path.join(src, 'lists-settings'))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.spec.'))
    .map((name) => path.join(src, 'lists-settings', name)),
  path.join(src, 'step-up', 'step-up.tsx'),
];
const CALL = /(?:callApi|guarded)(?:<[^(]*>)?\(\s*'(GET|PUT|POST|DELETE)',\s*(['`])([^'`]+)\2/g;

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

describe('every path the wallet, dispute, review moderation, account deletion, blog posts list, shipments, refunds, invoices and step-up client code calls passes the relay allowlist', () => {
  const found = calls();

  it('finds the calls it is meant to check', () => {
    const keys = found.map((call) => `${call.method} ${call.target.replaceAll(ID, ':id')}`);
    expect(new Set(keys)).toEqual(
      new Set([
        'GET wallet/admin/settings',
        'PUT wallet/admin/settings',
        'GET wallet/admin/customers/:id',
        // Customers phase 2b, part A: the promotions a customer used.
        'GET promotions/admin/customers/:id/usages',
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
        'POST ordering/admin/orders/:id/cancel',
        'POST ordering/admin/orders/:id/notes',
        'POST ordering/admin/orders/:id/seller-orders/:id/refunds',
        'GET ordering/admin/orders',
        'GET blog/admin/posts',
        'GET ordering/admin/shipments',
        'GET ordering/admin/refunds',
        'GET ordering/admin/documents',
        'GET ordering/admin/saved-filters',
        'POST ordering/admin/saved-filters',
        'PUT ordering/admin/saved-filters/:id',
        'DELETE ordering/admin/saved-filters/:id',
        'GET lists/admin/saved-filters',
        'POST lists/admin/saved-filters',
        'PUT lists/admin/saved-filters/order',
        'PUT lists/admin/saved-filters/:id',
        'DELETE lists/admin/saved-filters/:id',
        'GET customers/admin/account-deletion-settings',
        'PUT customers/admin/account-deletion-settings',
        'GET customers/admin/deletion-requests',
        'DELETE customers/admin/deletion-requests/:id',
        'POST customers/admin/buyers/:id/deletion-requests',
        'GET settings/admin/market-settings',
        'PUT settings/admin/market-settings',
        'POST customers/admin/list',
        'GET customers/admin/sellers/:id/customers/summary',
        'POST customers/admin/sellers/:id/customers/list',
        'POST customers/admin/seller-attributions/list',
        'POST customers/admin/seller-attributions/list/ids',
        'POST customers/admin/seller-attributions/decide',
        'POST sellers/admin/list',
        'GET customers/admin/saved-filters',
        'POST customers/admin/saved-filters',
        'PUT customers/admin/saved-filters/:id',
        'DELETE customers/admin/saved-filters/:id',
        'GET customers/admin/customers/:id',
        'POST customers/admin/customers/:id/tab-opened',
        // Customers phase 2a: groups, notes, activity and the name edit.
        'GET customers/admin/customers/:id/notes',
        'GET customers/admin/groups',
        'GET customers/admin/groups/:id',
        'POST customers/admin/customers/:id/activity',
        // Customers phase 2b, part C: the cart and behaviour reads (the eight super lists post to a
        // computed path; bff.spec.ts checks those and their exports one by one).
        'GET customers/admin/customers/:id/cart',
        'GET customers/admin/customers/:id/behaviour',
        'POST customers/admin/customers/:id/notes',
        'POST customers/admin/groups',
        'POST customers/admin/groups/:id/members/add',
        'POST customers/admin/groups/:id/members/remove',
        'PUT customers/admin/customers/:id/display-name',
        'PUT customers/admin/customers/:id/email',
        'DELETE customers/admin/customers/:id/email-change',
        'PUT customers/admin/groups/:id',
        // Customers phase 2b, part B: account and security.
        'GET customers/admin/customers/:id/sessions',
        'GET customers/admin/customers/:id/addresses',
        'GET customers/admin/customers/:id/consent',
        'GET customers/admin/customers/:id/behaviour',
        'POST customers/admin/customers/:id/sign-ins',
        'POST customers/admin/customers/:id/sign-ins/:id/reveal',
        'POST customers/admin/customers/:id/sessions/end',
        'POST customers/admin/customers/:id/password-reset',
        'POST customers/admin/customers/:id/addresses/:id/reveal',
        'POST customers/admin/customers/:id/consent-history',
        'POST identity/admin/customers/:id/disable',
        'POST identity/admin/customers/:id/enable',
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
