// The panel's API client, answered from fixtures: the list route and nothing else.
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const STATUSES = ['pending', 'pending', 'executing', 'cancelled', 'completed', 'pending'] as const;
const entries = Array.from({ length: 25 }, (_, n) => n).map((n) => {
  const status = STATUSES[n % 6]!;
  const cancelled = status === 'cancelled';
  return {
    requestId: id(900 + n),
    accountId: id(0xa000 + n),
    requestedAt: `2026-10-${String(5 + (n % 20)).padStart(2, '0')}T0${n % 10}:30:00Z`,
    scheduledFor: `2026-11-${String(4 + (n % 20)).padStart(2, '0')}T0${n % 10}:30:00Z`,
    status,
    requestedBy: n % 3 === 0 ? 'admin' : 'customer',
    cancelledAt: cancelled ? `2026-10-${String(9 + (n % 10)).padStart(2, '0')}T03:00:00Z` : null,
    cancelReason: cancelled ? 'sign-in' : null,
    completedAt:
      status === 'completed' ? `2026-11-${String(5 + (n % 10)).padStart(2, '0')}T03:00:00Z` : null,
    actions: status === 'pending' ? ['cancel'] : [],
  };
});

export function callApi(_method: string, path: string) {
  if (path.startsWith('customers/admin/deletion-requests?')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        entries,
        counts: { pending: 8, executing: 1, cancelled: 31, completed: 54, all: 94 },
        total: 94,
        page: 1,
        pageSize: 25,
        nextCursor: null,
      },
    });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
