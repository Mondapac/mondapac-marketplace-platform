import { BLOG_LISTS } from './list-definitions';
import { BLOG_POST_READ, BLOG_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { ListBlogPosts } from '../use-cases/list-posts.use-case';

// The saved-filter document of the admin Blog posts list (super list phase 4, PR10): closed and
// versioned, read by the list's own selector, stored in canonical form.

const ID = '01990000-0000-7000-8000-00000000E001';
const [LIST] = BLOG_LISTS;
if (LIST === undefined) throw new Error('missing list');
const fieldsOf = (result: ReturnType<typeof LIST.parsePayload>) =>
  result.ok ? null : result.error.fields;
const BASE = { v: 1, view: 'all', sort: 'created', direction: 'desc' } as const;

describe('the blog saved-filter list', () => {
  it('is guarded by the key the list use case checks and shared with the module key', () => {
    expect(LIST.listKey).toBe('admin.blog.posts');
    expect(LIST.population).toBe('admin');
    expect(LIST.viewKey).toBe(BLOG_POST_READ.key);
    expect(ListBlogPosts.access.rule).toEqual({ kind: 'permissions', allOf: [LIST.viewKey] });
    expect(LIST.shareKey).toBe(BLOG_SAVED_FILTER_SHARE.key);
  });

  it('keeps a document in its canonical form, with a Persian search as given', () => {
    const result = LIST.parsePayload({
      ...BASE,
      view: 'in_review',
      q: ' گوشت‌حلال ',
      filters: {
        kind: 'event',
        owner: 'seller',
        sellerId: ID,
        featured: 'false',
        to: '2026-11-15T00:00:00Z',
      },
      sort: 'updated',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...BASE,
        view: 'in_review',
        q: 'گوشت‌حلال',
        filters: {
          kind: 'event',
          owner: 'seller',
          sellerId: ID.toLowerCase(),
          featured: 'false',
          to: '2026-11-15T00:00:00Z',
        },
        sort: 'updated',
      },
    });
    if (result.ok) expect(LIST.parsePayload(result.value)).toEqual(result);
  });

  it.each([
    [{ ...BASE, columns: ['title'] }, 'payload.columns', 'unknown'],
    [{ ...BASE, filters: { status: 'draft' } }, 'payload.filters.status', 'unknown'],
    [{ ...BASE, v: null }, 'payload.v', 'value'],
    [{ ...BASE, view: 'live' }, 'payload.view', 'value'],
    [{ ...BASE, sort: 'title' }, 'payload.sort', 'value'],
    [{ ...BASE, direction: 'asc ' }, 'payload.direction', 'value'],
    [{ ...BASE, filters: { featured: 'yes' } }, 'payload.filters.featured', 'value'],
    [{ ...BASE, filters: { owner: 'admin' } }, 'payload.filters.owner', 'value'],
    [{ ...BASE, q: 'a\u0007b' }, 'payload.q', 'format'],
    [{ ...BASE, q: 'x'.repeat(101) }, 'payload.q', 'length'],
  ])('refuses a document that is not one the list accepts (%#)', (payload, path, code) => {
    expect(fieldsOf(LIST.parsePayload(payload))).toContainEqual({ path, code });
  });
});
