// The panel's API client, answered from fixtures: the list route and nothing else. The Drafts and
// Archived views and any search answer no posts.
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const STATUSES = [
  'published',
  'draft',
  'in_review',
  'scheduled',
  'changes_requested',
  'approved',
  'unpublished',
  'archived',
] as const;
const KINDS = ['product', 'brand', 'event', 'news'] as const;
const TITLES = [
  'Eid sweets from three Brisbane bakeries and how to order them for the weekend',
  'Meet the family behind Saffron & Co',
  'Ramadan market evening at Sunnybank',
  'Halal certification explained: what the badge on a product means',
  'New this week',
  'Why we ask every seller for a certificate',
];
const entries = Array.from({ length: 25 }, (_, n) => n).map((n) => {
  const status = STATUSES[n % STATUSES.length]!;
  const open = status === 'published' && n % 3 === 0 ? 'in_review' : null;
  const actions = ['open'];
  if (n % 2 === 0) actions.push('edit');
  if (status === 'in_review') actions.push('approve', 'request-changes');
  if (status === 'published' || status === 'approved') actions.push('pause', 'feature');
  return {
    id: id(900 + n),
    kind: KINDS[n % 4]!,
    slug: `post-${n}-${TITLES[n % TITLES.length]!.toLowerCase()
      .replace(/[^a-z]+/g, '-')
      .slice(0, 30)}`,
    ownerType: n % 3 === 1 ? 'seller' : 'platform',
    sellerId: null,
    status,
    openState: open,
    title: TITLES[n % TITLES.length]!,
    featured: n === 3,
    scheduledAt: status === 'scheduled' ? '2026-11-24T21:00:00Z' : null,
    publishedAt:
      status === 'published' ? `2026-10-${String(5 + (n % 20)).padStart(2, '0')}T03:20:00Z` : null,
    updatedAt: `2026-11-${String(1 + (n % 17)).padStart(2, '0')}T0${n % 10}:30:00Z`,
    actions,
  };
});
const counts = {
  all: 94,
  draft: 8,
  in_review: 6,
  changes_requested: 3,
  approved: 4,
  scheduled: 5,
  published: 60,
  unpublished: 3,
  archived: 5,
};

export function callApi(_method: string, path: string) {
  if (path.startsWith('blog/admin/posts?')) {
    const params = new URL(`http://x/${path}`).searchParams;
    const none =
      params.get('q') !== null ||
      params.get('view') === 'draft' ||
      params.get('view') === 'archived';
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        items: none ? [] : entries,
        counts,
        total: none ? 0 : 94,
        page: 1,
        pageSize: 25,
        hasMore: !none,
        nextCursor: null,
      },
    });
  }
  return Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } });
}
