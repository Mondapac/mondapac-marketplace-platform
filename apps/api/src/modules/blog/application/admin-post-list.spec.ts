import ExcelJS from 'exceljs';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../platform/list-export';
import { blogHarness, type BlogHarness } from '../../../../test/support/blog-harness';
import {
  aCategory,
  approvedNews,
  createNews,
  EVERYTHING,
  liveNews,
  refusal,
  SELLER_KEYS,
  unwrap,
  WRITER,
} from '../../../../test/support/blog-fixtures';
import { BLOG_POST_READ } from '../contracts/permissions';
import { encodePostListCursor } from './admin-post-list-flow';
import type { PostId } from './ports/blog.repository';

// The admin Blog posts super list (phase 4, list 26) and its export, on both Market fixtures.
// Nothing here changes a post: the row actions only name what the caller may open.

const READ = [BLOG_POST_READ.key];

async function text(file: ExportFile): Promise<string> {
  let out = '';
  for await (const chunk of file.chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}
const linesOf = async (file: ExportFile) =>
  (await text(file))
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter(Boolean);

describe.each([['AU'], ['ZZ']] as const)('the admin Blog posts list in %s', (code) => {
  let h: BlogHarness;
  let category: string;
  const everything = () => h.admin('editor', EVERYTHING);
  const reader = () => h.admin('reader', READ);
  const list = (query: Record<string, unknown> = {}, context = everything()) =>
    h.cases.listPosts.execute(context, { query });
  const exportOf = (query: Record<string, unknown> = {}, context = everything()) =>
    h.cases.exportPosts.execute(context, { query });
  const next = () => h.clock.advance(Temporal.Duration.from({ hours: 1 }));

  /** A draft, an approved post and a live one, created an hour apart in that order. */
  async function three() {
    const draft = await createNews(h, h.admin('writer', WRITER), category, 'Eid sweets');
    next();
    const approved = await approvedNews(h, category, 'Market day');
    next();
    const live = await liveNews(h, category, 'Ramadan table ideas');
    next();
    return { draft, approved, live };
  }

  beforeEach(async () => {
    h = blogHarness(code);
    category = await aCategory(h);
  });

  describe('reading', () => {
    it('opens on all posts, newest first, with counts per view, a total and each row’s actions', async () => {
      const { draft, approved, live } = await three();
      const page = unwrap(await list());
      expect(page.items.map((row) => row.id)).toEqual([live.id, approved.id, draft.id]);
      expect(page).toMatchObject({ total: 3, page: 1, pageSize: 25, hasMore: false });
      expect(page.nextCursor).toBeNull();
      expect(page.counts).toMatchObject({ draft: 1, approved: 1, published: 1, all: 3 });
      const actions = Object.fromEntries(page.items.map((row) => [row.id, row.actions]));
      expect(actions[draft.id]).toEqual(['open', 'edit', 'submit', 'archive']);
      expect(actions[approved.id]).toEqual(['open', 'edit', 'publish', 'schedule', 'archive']);
      expect(actions[live.id]).toEqual([
        'open',
        'edit',
        'pause',
        'archive',
        'rename-slug',
        'feature',
      ]);
      expect(page.items[0]).toMatchObject({
        title: 'Ramadan table ideas',
        kind: 'news',
        ownerType: 'platform',
        status: 'published',
      });
      expect(JSON.stringify(page)).not.toContain('Start with dates');
    });

    it('offers only Open to a reader, and nothing of edit or submit on a seller’s post', async () => {
      const { draft } = await three();
      expect(
        unwrap(await list({}, reader())).items.every((row) => row.actions.join() === 'open'),
      ).toBe(true);
      const record = h.repo.allPosts(h.market).find((post) => post.id === draft.id)!;
      const sellerPost = {
        ...record,
        id: '0197b000-0000-7000-8000-0000000000f1' as PostId,
        slug: 'seller-sweets',
        ownerType: 'seller' as const,
        sellerId: '0197b000-0000-7000-8000-0000000000f2' as Id<'Seller'>,
        createdAt: record.createdAt.add({ hours: 10 }),
      };
      await h.repo.insertPost(h.market, sellerPost);
      const row = unwrap(await list()).items[0]!;
      expect(row.id).toBe(sellerPost.id);
      expect(row.actions).toEqual(['open', 'archive']);
      expect(unwrap(await list({ owner: 'seller' })).items.map((r) => r.id)).toEqual([
        sellerPost.id,
      ]);
      expect(unwrap(await list({ sellerId: sellerPost.sellerId })).total).toBe(1);
    });

    it('shows one status by `view` or the older `status`, and filters by search, kind, featured and dates', async () => {
      const { draft, live } = await three();
      expect(unwrap(await list({ view: 'draft' })).items.map((r) => r.id)).toEqual([draft.id]);
      expect(unwrap(await list({ status: 'published' })).items.map((r) => r.id)).toEqual([live.id]);
      expect(unwrap(await list({ q: 'EID' })).items.map((r) => r.id)).toEqual([draft.id]);
      expect(unwrap(await list({ q: live.slug })).items.map((r) => r.id)).toEqual([live.id]);
      expect(unwrap(await list({ kind: 'event' })).total).toBe(0);
      expect(unwrap(await list({ featured: 'false' })).total).toBe(3);
      expect(unwrap(await list({ featured: 'true' })).total).toBe(0);
      const narrowed = unwrap(await list({ to: draft.updatedAt.add({ minutes: 1 }).toString() }));
      expect(narrowed.items.map((r) => r.id)).toEqual([draft.id]);
    });

    it('sorts by created, updated, published and scheduled, not published last either way', async () => {
      const { draft, approved, live } = await three();
      expect(
        unwrap(await list({ sort: 'created', direction: 'asc' })).items.map((r) => r.id),
      ).toEqual([draft.id, approved.id, live.id]);
      for (const direction of ['asc', 'desc']) {
        const ids = unwrap(await list({ sort: 'published', direction })).items.map((r) => r.id);
        expect(ids[0]).toBe(live.id);
      }
      expect(unwrap(await list({ sort: 'updated' })).items[0]!.id).toBe(live.id);
    });

    it('pages by numbers with a total and hasMore, and by Previous/Next with a cursor', async () => {
      const { draft, approved, live } = await three();
      const second = unwrap(await list({ page: '2', pageSize: '2' }));
      expect(second.items.map((r) => r.id)).toEqual([draft.id]);
      expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2, hasMore: false });
      expect(unwrap(await list({ pageSize: '2' })).hasMore).toBe(true);
      const first = unwrap(await list({ limit: '2' }));
      expect(first.items.map((r) => r.id)).toEqual([live.id, approved.id]);
      expect(first).toMatchObject({ total: null, page: null, pageSize: 2, hasMore: true });
      expect(first.nextCursor).toBe(
        encodePostListCursor({ createdAt: approved.createdAt, id: approved.id }),
      );
      const rest = unwrap(await list({ limit: '2', cursor: first.nextCursor }));
      expect(rest.items.map((r) => r.id)).toEqual([draft.id]);
      expect(rest.nextCursor).toBeNull();
    });

    it('keeps to its own Market', async () => {
      await three();
      const other = blogHarness(code === 'AU' ? 'ZZ' : 'AU');
      const page = unwrap(
        await other.cases.listPosts.execute(other.admin('editor', EVERYTHING), { query: {} }),
      );
      expect(page.items).toEqual([]);
      expect(page.counts.all).toBe(0);
    });
  });

  describe('refusals', () => {
    it.each([
      [{ view: 'live' }, 'view', 'value'],
      [{ status: 'live' }, 'status', 'value'],
      [{ status: 'draft', view: 'all' }, 'status', 'with-view'],
      [{ kind: 'recipe' }, 'kind', 'value'],
      [{ owner: 'buyer' }, 'owner', 'value'],
      [{ sellerId: 'x' }, 'sellerId', 'format'],
      [{ featured: 'yes' }, 'featured', 'value'],
      [{ q: 'a'.repeat(101) }, 'q', 'length'],
      [{ from: '2026-11-01' }, 'from', 'format'],
      [{ from: '2026-11-03T00:00:00Z', to: '2026-11-02T00:00:00Z' }, 'to', 'range'],
      [{ sort: 'title' }, 'sort', 'value'],
      [{ direction: 'up' }, 'direction', 'value'],
      [{ page: '0' }, 'page', 'range'],
      [{ pageSize: '101' }, 'pageSize', 'range'],
      [{ page: '101', pageSize: '100' }, 'page', 'too-deep'],
      [{ limit: '0' }, 'limit', 'range'],
      [{ cursor: 'nope' }, 'cursor', 'format'],
      [{ limit: '5', sort: 'updated' }, 'sort', 'with-cursor'],
      [{ html: '1' }, 'html', 'unknown-field'],
      [{ page: ['1', '2'] }, 'page', 'type'],
    ])('refuses %j at %s (%s)', async (query, path, code) => {
      expect(refusal(await list(query))).toEqual({
        code: 'validation.failed',
        fields: expect.arrayContaining([{ path, code }]) as unknown,
      });
    });

    it('refuses a seller and anyone without the read key', async () => {
      const seller = h.seller('0197b000-0000-7000-8000-0000000000f2' as Id<'Seller'>, SELLER_KEYS);
      expect(refusal(await list({}, seller)).code).toBe('access.denied');
      expect(refusal(await exportOf({}, seller)).code).toBe('access.denied');
      expect(refusal(await list({}, h.admin('nobody', []))).code).toBe('access.denied');
      expect(refusal(await exportOf({}, h.admin('nobody', []))).code).toBe('access.denied');
    });
  });

  describe('the export', () => {
    it('writes the list as CSV in its sort, with chosen columns, and no body text', async () => {
      const { draft, live } = await three();
      const file = unwrap(await exportOf({ view: 'all', sort: 'created', direction: 'asc' }));
      expect(file.filename).toMatch(/^blog-posts-\d{4}-\d{2}-\d{2}\.csv$/);
      const lines = await linesOf(file);
      expect(lines[0]).toBe('Post ID,Title,Type,Author,Status,Updated (UTC)');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toBe(
        `${draft.id},Eid sweets,News,Platform,Draft,${draft.updatedAt.toString()}`,
      );
      expect(lines.join('\n')).not.toContain('Start with dates');
      const wide = await linesOf(
        unwrap(await exportOf({ ids: live.id, columns: 'slug,stage,featured,published' })),
      );
      expect(wide[0]).toBe(
        'Post ID,Title,Type,Author,Status,Updated (UTC),Slug,Stage,Featured,Published (UTC)',
      );
      expect(wide[1]!.endsWith(`,${live.slug},,No,${live.publishedAt!.toString()}`)).toBe(true);
    });

    it('guards a title that starts like a formula', async () => {
      await createNews(h, h.admin('writer', WRITER), category, '=HYPERLINK("http://x","y")');
      const lines = await linesOf(unwrap(await exportOf()));
      expect(lines[1]).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    });

    it('writes the chosen ids in the order given, and refuses an id that is no post of the Market', async () => {
      const { draft, live } = await three();
      const lines = await linesOf(unwrap(await exportOf({ ids: `${draft.id},${live.id}` })));
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([draft.id, live.id]);
      // An id that is no post of this Market (the other Market's ids are not reachable here).
      const unknown = '0197b000-0000-7000-8000-0000000000aa';
      expect(refusal(await exportOf({ ids: `${draft.id},${unknown}` })).code).toBe(
        'blog.post-not-found',
      );
    });

    it('writes an XLSX file of strings only', async () => {
      await three();
      const xlsx = unwrap(await exportOf({ format: 'xlsx' }));
      expect(xlsx.filename).toMatch(/\.xlsx$/);
      const parts: Buffer[] = [];
      for await (const chunk of xlsx.chunks) {
        parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.concat(parts) as unknown as ArrayBuffer);
      const sheet = book.getWorksheet('Blog posts')!;
      expect(sheet.rowCount).toBe(4);
      const values: unknown[] = [];
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          values.push(cell.value);
        }),
      );
      expect(values.every((value) => typeof value === 'string')).toBe(true);
    });

    it.each([
      [{ format: 'pdf' }],
      [{ columns: 'body' }],
      [{ page: '2' }],
      [{ ids: 'not-an-id' }],
      [{ view: 'live' }],
      [
        {
          ids: Array.from(
            { length: 201 },
            (_, i) => `0197b000-0000-7000-8000-${String(i).padStart(12, '0')}`,
          ).join(','),
        },
      ],
    ])('refuses %j', async (query) => {
      const result = await exportOf(query);
      expect(result.ok).toBe(false);
    });

    it('refuses more than 10,000 matching posts with the total', async () => {
      await createNews(h, h.admin('writer', WRITER), category);
      const list = h.deps.posts;
      const many = Array.from({ length: 10_001 }, (_, i) => i);
      const spy = jest.spyOn(list, 'listPosts').mockResolvedValue(
        many.map((i) => ({
          post: {
            ...h.repo.allPosts(h.market)[0]!,
            id: `0197b000-0000-7000-8000-${String(i).padStart(12, '0')}` as PostId,
          },
          title: 't',
          openState: null,
        })),
      );
      expect(refusal(await exportOf())).toEqual({
        code: 'batch.too-large',
        max: 10_000,
        total: 10_001,
      });
      spy.mockRestore();
    });
  });
});
