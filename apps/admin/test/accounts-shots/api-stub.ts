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
const statuses = ['enabled', 'restricted', 'pending', 'enabled', 'not-started', 'rejected'];
const items = Array.from({ length: 25 }, (_, n) => n).map((n) => {
  const i = n % 6;
  return {
    sellerId: id(300 + n),
    sellerName: stores[i]!,
    status: statuses[i]!,
    ready: i === 0 || i === 3,
    requirementsDue: i === 1 ? 3 : i === 2 ? 1 : 0,
    requirementsPastDue: i === 1,
    coolingOffUntil: i === 3 ? `2026-11-${String(20 + (n % 5)).padStart(2, '0')}T03:30:00Z` : null,
    payoutsPaused: i === 1,
    lastReadAt: i === 4 ? null : `2026-11-${String(10 + i).padStart(2, '0')}T0${n % 10}:30:00Z`,
    createdAt: `2026-10-${String(1 + n).padStart(2, '0')}T02:30:00Z`,
    actions: ['open'],
  };
});

export function callApi(_method: string, path: string) {
  if (path.startsWith('payments/admin/connected-accounts?')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        items,
        counts: {
          all: 143,
          'not-started': 12,
          pending: 9,
          enabled: 104,
          restricted: 14,
          rejected: 4,
        },
        total: 143,
        page: 1,
        pageSize: 25,
        paging: 'pages',
        hasNext: true,
        searchCapped: false,
      },
    });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
