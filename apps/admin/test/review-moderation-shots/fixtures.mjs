// The fixture answers of the API routes the list reads (no author is ever in them).
const id = (n) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const reviews = [
  [
    1,
    'Awful',
    'Not what I ordered. The meat smelled off and the seller would not answer my calls.',
    'held',
    0,
    ['profanity'],
    ['open', 'publish', 'hide', 'remove'],
  ],
  [
    2,
    null,
    'Call me on 0400 000 000 for a cheaper deal on the same lamb.',
    'held',
    1,
    ['phone-number'],
    ['open', 'publish', 'hide', 'remove', 'dismiss-reports'],
  ],
  [
    5,
    'Great dates',
    'Fresh and well packed. Will buy again.',
    'published',
    3,
    [],
    ['open', 'hide', 'remove', 'dismiss-reports'],
  ],
  [3, 'OK', null, 'hidden', 0, [], ['open', 'restore', 'remove']],
  [
    1,
    'Scam',
    'Do not buy from this shop, they are thieves and liars and should be shut down for good.',
    'removed',
    0,
    ['repeated-text'],
    ['open'],
  ],
].map(([rating, title, body, status, openReports, signalCodes, actions], i) => ({
  id: id(100 + i),
  productId: id(200 + i),
  offerId: id(300 + i),
  sellerId: id(400 + (i % 2)),
  rating,
  title,
  body,
  locale: 'en-AU',
  status,
  createdAt: `2026-11-1${i}T0${i}:30:00.000Z`,
  editedAt: i === 2 ? '2026-11-15T03:00:00.000Z' : null,
  openReports,
  signalCodes,
  actions,
}));
export const list = {
  items: reviews,
  total: 143,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: true,
  counts: { all: 143, held: 61, reported: 40, actioned: 42 },
};
export const detail = {
  ...reviews[0],
  reportReasons: [{ reasonCode: 'abusive', count: 2 }],
  history: [
    {
      action: 'auto-hold',
      reasonCode: 'auto-check',
      fromStatus: null,
      toStatus: 'held',
      byModerator: false,
      at: reviews[0].createdAt,
    },
  ],
  allowedActions: ['publish', 'hide', 'remove'],
};
export const saved = {
  items: [
    {
      id: id(900),
      listKey: 'admin.reviews.moderation',
      name: 'Low stars reported',
      visibility: 'me',
      payload: { v: 1, view: 'reported', filters: { maxRating: '2' } },
      ownedByMe: true,
      canManage: true,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  canShare: true,
};
