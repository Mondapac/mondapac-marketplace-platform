// The panel's API client, answered from fixtures: the two list routes and nothing else. The page
// hash picks a state: `#empty` (no rows at all) or `#nomatch` (rows, but none match a filter).
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const hash = () => globalThis.location.hash;

const KINDS = [
  'sale',
  'shipping',
  'commission',
  'sale',
  'refund-sale',
  'refund-commission',
  'sale',
  'commission',
  'dispute-debit',
  'cashback-seller',
] as const;
const DEBITS = new Set([
  'commission',
  'refund-sale',
  'refund-shipping',
  'dispute-debit',
  'cashback-seller',
]);
const ledgerRows = Array.from({ length: 25 }, (_, n) => {
  const kind = KINDS[n % KINDS.length]!;
  const day = String(28 - (n % 26)).padStart(2, '0');
  return {
    entryId: id(5000 + n),
    orderId: id(7000 + Math.floor(n / 2)),
    sellerOrderId: id(8000 + Math.floor(n / 2)),
    orderLineId: null,
    kind,
    direction: DEBITS.has(kind) ? 'debit' : 'credit',
    amount: String(1500 + ((n * 3777) % 48000)),
    rateBps: kind === 'commission' ? 1500 : null,
    baseAmount: kind === 'commission' ? '9000' : null,
    sourceId: null,
    occurredAt: `2026-10-${day}T0${n % 10}:10:00Z`,
    recordedAt: `2026-10-${day}T0${n % 10}:15:00Z`,
    actions: ['open-order'],
  };
});

const holdRows = [
  { reason: 'admin-review', origin: 'admin', order: null, active: true },
  { reason: 'dispute', origin: 'system', order: 8001, active: true },
  { reason: 'seller-suspended', origin: 'system', order: null, active: true },
  { reason: 'bank-change', origin: 'system', order: null, active: true },
  { reason: 'admin-review', origin: 'admin', order: 8004, active: false },
  { reason: 'refund-pending', origin: 'system', order: 8005, active: false },
  { reason: 'dispute', origin: 'system', order: 8002, active: false },
].map((hold, n) => ({
  holdId: id(6000 + n),
  sellerId: id(0xc1),
  sellerOrderId: hold.order === null ? null : id(hold.order),
  reason: hold.reason,
  origin: hold.origin,
  placedAt: `2026-10-${String(20 - n).padStart(2, '0')}T01:30:00Z`,
  active: hold.active,
  releasedAt: hold.active ? null : `2026-10-${String(24 - n).padStart(2, '0')}T02:00:00Z`,
  releaseReason: hold.active ? null : 'resolved',
  actions: [
    ...(hold.order === null ? [] : ['open-order']),
    ...(hold.active && (hold.origin === 'admin' || hold.reason === 'seller-suspended')
      ? ['release']
      : []),
  ],
}));

const TOTALS = {
  sales: '1284500',
  shipping: '96200',
  commission: '192675',
  refundedSales: '45000',
  refundedShipping: '4000',
  refundedCommission: '6750',
  disputeDebits: '15000',
  disputeReinstated: '0',
  sellerCashback: '2500',
  balance: '1021275',
};

export function callApi(_method: string, path: string) {
  const none = hash() === '#empty';
  const narrow =
    hash() === '#nomatch' && /[?&](kind|side|status|reason|q|sellerOrderId)=/.test(path);
  if (path.includes('/ledger?')) {
    const entries = none || narrow ? [] : ledgerRows;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        sellerId: id(0xc1),
        currency: 'AUD',
        totals: TOTALS,
        entries,
        nextCursor: null,
        total: entries.length === 0 ? 0 : 1243,
        page: 1,
        pageSize: 25,
      },
    });
  }
  if (path.includes('/payout-holds?')) {
    const holds = none || narrow ? [] : holdRows;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        holds,
        counts: none ? { active: 0, released: 0 } : { active: 4, released: 3 },
        total: holds.length,
        page: 1,
        pageSize: 25,
        nextCursor: null,
      },
    });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
