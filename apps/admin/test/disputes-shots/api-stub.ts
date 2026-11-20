// The panel's API client, answered from fixtures: the list route and nothing else.
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const stores = [
  'Cedar Lane Halal Meats',
  'Sunnybank Butchery and Fine Foods of Greater Brisbane',
  null,
  'Logan Road Grocer',
  'Mt Gravatt Sweets',
  'Inala Spice House',
];
const buckets = [
  'needs-response',
  'decision-needed',
  'under-review',
  'won',
  'closed',
  'needs-response',
];
const statuses = [
  'needs_response',
  'lost',
  'under_review',
  'won',
  'warning_closed',
  'warning_needs_response',
];
const money = ['withdrawn', 'withdrawn', 'withdrawn', 'reinstated', 'none', 'inquiry'];
const reasons = [
  'product_not_received',
  'fraudulent',
  'product_unacceptable',
  'duplicate',
  'general',
  'credit_not_processed',
];
const disputes = Array.from({ length: 25 }, (_, n) => n).map((n) => {
  const i = n % 6;
  return {
    disputeId: id(700 + n),
    orderId: id(500 + n),
    sellers:
      i === 1
        ? [
            { sellerId: id(300), storeName: stores[0]! },
            { sellerId: id(304), storeName: stores[4]! },
          ]
        : [{ sellerId: id(300 + i), storeName: stores[i]! }],
    reason: reasons[i]!,
    moneyState: money[i]!,
    status: statuses[i]!,
    bucket: buckets[i]!,
    evidenceDueBy:
      i === 0 || i === 5 ? `2026-11-${String(18 + (n % 6)).padStart(2, '0')}T10:00:00Z` : null,
    amount: { amountMinor: String(4500 + n * 1375), currency: 'AUD' },
    openedAt: `2026-11-${String(1 + (n % 15)).padStart(2, '0')}T0${n % 10}:30:00Z`,
    updatedAt: `2026-11-${String(2 + (n % 15)).padStart(2, '0')}T0${n % 10}:30:00Z`,
    actions: i === 1 ? ['open', 'decide'] : ['open'],
  };
});

export function callApi(_method: string, path: string) {
  if (path.startsWith('commission-payouts/admin/disputes?')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        disputes,
        counts: {
          all: 143,
          'needs-response': 12,
          'decision-needed': 4,
          'under-review': 9,
          won: 61,
          closed: 57,
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
