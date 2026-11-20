// The panel's API client, answered from fixtures: the list route and nothing else.
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = id(0xa1);
const OTHER = id(0xb2);
const STATUSES = ['pending', 'granted', 'approved', 'rejected', 'expired', 'pending'] as const;
const REASONS = ['goodwill', 'service-recovery', 'promotion', 'correction'];
const entries = Array.from({ length: 25 }, (_, n) => n).map((n) => {
  const status = STATUSES[n % 6]!;
  const decided = status === 'approved' || status === 'rejected';
  const mine = n === 5;
  return {
    id: id(900 + n),
    customerAccountId: id(0xc000 + n),
    amount: String(2500 + n * 18750),
    currency: 'AUD',
    reasonCode: REASONS[n % 4]!,
    note: n % 3 === 0 ? 'Late delivery of the weekly box.\nCustomer called twice.' : null,
    status,
    approvalReason: status === 'granted' ? null : n % 2 === 0 ? 'issue-cap' : 'daily-cap',
    requestedBy: mine ? ME : OTHER,
    requestedAt: `2026-11-${String(1 + (n % 15)).padStart(2, '0')}T0${n % 10}:30:00Z`,
    expiresAt:
      status === 'pending' ? `2026-11-${String(18 + (n % 6)).padStart(2, '0')}T01:00:00Z` : null,
    decidedBy: decided ? OTHER : null,
    decidedAt: decided ? `2026-11-${String(2 + (n % 15)).padStart(2, '0')}T03:00:00Z` : null,
    decisionReason: status === 'rejected' ? 'duplicate' : null,
    journalId: status === 'granted' || status === 'approved' ? id(5000 + n) : null,
    actions: status === 'pending' && !mine ? ['open', 'approve', 'reject'] : ['open'],
  };
});

export function callApi(_method: string, path: string) {
  if (path.startsWith('wallet/admin/credit-requests?')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        entries,
        counts: { pending: 8, decided: 31, granted: 54, all: 93 },
        total: 93,
        page: 1,
        pageSize: 25,
        nextCursor: null,
      },
    });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
