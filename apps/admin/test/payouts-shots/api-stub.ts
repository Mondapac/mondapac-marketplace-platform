// The panel's API client, answered from fixtures: the list route and nothing else.
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
const stores = [
  'Cedar Lane Halal Meats',
  'Sunnybank Butchery and Fine Foods of Greater Brisbane',
  null,
  'Logan Road Grocer',
  'Mt Gravatt Sweets',
  'Inala Spice House',
];
const states = ['awaiting-approval', 'awaiting-approval', 'approved', 'paid', 'failed', 'not-sent'];
const payouts = stores.map((storeName, i) => ({
  payoutId: id(100 + i),
  sellerId: id(300 + i),
  storeName,
  state: states[i]!,
  gross: aud(String(330000 + i * 12345)),
  netted: aud(i === 1 ? '25000' : '0'),
  transfer: aud(String(330000 + i * 12345 - (i === 1 ? 25000 : 0))),
  approvalMode: i < 2 ? 'MANUAL' : 'AUTO',
  approvalReason: i === 0 ? 'first-payout' : i === 1 ? 'terms' : null,
  slotAt: `2026-11-${String(18 + (i % 3)).padStart(2, '0')}T00:00:00Z`,
  outcomeCode: i === 5 ? 'payout-unwound' : null,
  createdAt: `2026-11-${String(10 + i).padStart(2, '0')}T02:30:00Z`,
  stateChangedAt: `2026-11-${String(12 + i).padStart(2, '0')}T05:00:00Z`,
  activeHoldId: i === 2 ? id(900) : null,
  actions:
    i < 2 ? ['open', 'approve', 'place-hold'] : i === 2 ? ['open', 'release-hold'] : ['open'],
}));

export function callApi(_method: string, path: string) {
  if (path.startsWith('commission-payouts/admin/payouts?')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        payouts,
        counts: {
          all: 143,
          'awaiting-approval': 2,
          sending: 5,
          paid: 128,
          failed: 6,
          'not-sent': 2,
        },
        total: 143,
        page: 1,
        pageSize: 25,
        nextCursor: null,
        searchCapped: false,
      },
    });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
