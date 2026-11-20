// The panel's API client, answered from fixtures: the payout list route and nothing else.
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
const statuses = [
  'paid',
  'paid',
  'on-its-way',
  'scheduled',
  'awaiting-approval',
  'failed',
  'not-sent',
  'settled',
];
export const payouts = Array.from({ length: 25 }, (_, n) => {
  const status = statuses[n % statuses.length]!;
  const day = String(28 - (n % 28)).padStart(2, '0');
  return {
    payoutId: id(100 + n),
    status,
    gross: aud(String(330000 + n * 12345)),
    netted: aud(n % 5 === 1 ? '25000' : status === 'settled' ? '40000' : '0'),
    transfer: aud(
      status === 'settled' ? '0' : String(330000 + n * 12345 - (n % 5 === 1 ? 25000 : 0)),
    ),
    slotAt: `2026-11-${day}T00:00:00Z`,
    createdAt: `2026-11-${day}T0${n % 10}:30:00Z`,
    updatedAt: `2026-11-${day}T05:00:00Z`,
    reason: status === 'not-sent' ? 'below-minimum' : null,
    actions: ['open'],
  };
});
export const counts = {
  all: 143,
  scheduled: 4,
  'awaiting-approval': 1,
  'on-its-way': 2,
  paid: 128,
  'not-sent': 3,
  failed: 2,
  settled: 3,
};
export const first = {
  payouts,
  counts,
  total: 143,
  page: 1,
  pageSize: 25,
  nextCursor: null,
};
export const emptyPage = {
  payouts: [],
  counts: {
    ...counts,
    all: 0,
    paid: 0,
    scheduled: 0,
    'awaiting-approval': 0,
    'on-its-way': 0,
    'not-sent': 0,
    failed: 0,
    settled: 0,
  },
  total: 0,
  page: 1,
  pageSize: 25,
  nextCursor: null,
};

export function callApi(_method: string, path: string) {
  if (path.startsWith('commission-payouts/seller/payouts?')) {
    return Promise.resolve({ ok: true, status: 200, body: first });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
