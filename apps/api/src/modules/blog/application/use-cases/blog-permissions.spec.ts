import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  aCategory,
  approvedNews,
  content,
  createNews,
  PUBLISHER,
  refusal,
  REVIEWER,
  SELLER_KEYS,
  unwrap,
  WRITER,
} from '../../../../../test/support/blog-fixtures';
import { blogHarness, quietLogs } from '../../../../../test/support/blog-harness';
import {
  BLOG_POST_EDIT,
  BLOG_POST_PAUSE,
  BLOG_POST_PUBLISH,
  BLOG_POST_READ,
  BLOG_POST_REVIEW,
  BLOG_SELLER_POST_EDIT,
  BLOG_TAXONOMY_EDIT,
} from '../../contracts/permissions';

// Who may do what: each use case behind its permission, the separation of duties between the
// person who writes, the person who sends and the person who approves, the step-up self-approval
// of a single-admin Market, and the seller's key that works only while its blog switch is on.

quietLogs();

type Harness = ReturnType<typeof blogHarness>;
const POST = '0197b000-0000-7000-8000-0000000000aa';

/** Every admin use case with the one key it needs and an input that reaches the gate. */
const ADMIN_CASES: readonly [string, string, (h: Harness) => unknown][] = [
  ['listPosts', BLOG_POST_READ.key, () => ({})],
  ['viewPost', BLOG_POST_READ.key, () => ({ post: POST })],
  ['createPost', BLOG_POST_EDIT.key, () => ({ body: {} })],
  ['updateDraft', BLOG_POST_EDIT.key, () => ({ post: POST, body: {} })],
  ['submitPost', BLOG_POST_EDIT.key, () => ({ post: POST })],
  ['changeEventStatus', BLOG_POST_EDIT.key, () => ({ post: POST, body: {} })],
  ['preparePostCopy', BLOG_POST_EDIT.key, () => ({ post: POST })],
  ['reviewerEdit', BLOG_POST_REVIEW.key, () => ({ post: POST, body: {} })],
  ['runChecks', BLOG_POST_REVIEW.key, () => ({ post: POST })],
  ['approvePost', BLOG_POST_REVIEW.key, () => ({ post: POST, body: {} })],
  ['requestChanges', BLOG_POST_REVIEW.key, () => ({ post: POST, body: {} })],
  ['publishPost', BLOG_POST_PUBLISH.key, () => ({ post: POST, body: {} })],
  ['schedulePost', BLOG_POST_PUBLISH.key, () => ({ post: POST, body: {} })],
  ['unschedulePost', BLOG_POST_PUBLISH.key, () => ({ post: POST })],
  ['resumePost', BLOG_POST_PUBLISH.key, () => ({ post: POST })],
  ['archivePost', BLOG_POST_PUBLISH.key, () => ({ post: POST })],
  ['renamePostSlug', BLOG_POST_PUBLISH.key, () => ({ post: POST, body: {} })],
  ['featurePost', BLOG_POST_PUBLISH.key, () => ({ post: POST, body: {} })],
  ['pausePost', BLOG_POST_PAUSE.key, () => ({ post: POST, body: {} })],
  ['listTaxonomy', BLOG_POST_READ.key, () => undefined],
  ['createCategory', BLOG_TAXONOMY_EDIT.key, () => ({ body: {} })],
  ['updateCategory', BLOG_TAXONOMY_EDIT.key, () => ({ category: POST, body: {} })],
  ['deleteCategory', BLOG_TAXONOMY_EDIT.key, () => ({ category: POST })],
  ['createTag', BLOG_TAXONOMY_EDIT.key, () => ({ body: {} })],
  ['deleteTag', BLOG_TAXONOMY_EDIT.key, () => ({ tag: POST })],
];

const SELLER_CASES: readonly [string, (h: Harness) => unknown][] = [
  ['sellerListPosts', () => ({})],
  ['sellerViewPost', () => ({ post: POST })],
  ['sellerCreatePost', () => ({ body: {} })],
  ['sellerUpdateDraft', () => ({ post: POST, body: {} })],
  ['sellerSubmitPost', () => ({ post: POST })],
  ['sellerArchivePost', () => ({ post: POST })],
  ['sellerChangeEventStatus', () => ({ post: POST, body: {} })],
  ['sellerListTaxonomy', () => undefined],
];

const run = (h: Harness, name: string, context: CallContext, input: unknown) =>
  (
    h.cases as unknown as Record<
      string,
      { execute(c: CallContext, i: unknown): Promise<{ ok: boolean; error?: { code: string } }> }
    >
  )[name]!.execute(context, input);

describe.each([['AU'], ['ZZ']] as const)('blog permissions in %s', (code) => {
  describe.each(ADMIN_CASES)('%s', (name, key, input) => {
    it(`is denied without ${key} and reaches the use case with it`, async () => {
      const h = blogHarness(code);
      const none = await run(h, name, h.admin('nobody', []), input(h));
      expect(none).toMatchObject({ ok: false, error: { code: 'access.denied' } });

      // Every other key of the blog is not enough.
      const others = [
        BLOG_POST_READ,
        BLOG_POST_EDIT,
        BLOG_POST_REVIEW,
        BLOG_POST_PUBLISH,
        BLOG_POST_PAUSE,
        BLOG_TAXONOMY_EDIT,
      ]
        .map((permission) => permission.key)
        .filter((other) => other !== key);
      const wrong = await run(h, name, h.admin('wrong-keys', others), input(h));
      expect(wrong).toMatchObject({ ok: false, error: { code: 'access.denied' } });

      const right = await run(h, name, h.admin('right-key', [key]), input(h));
      expect(right.ok ? 'ok' : right.error?.code).not.toBe('access.denied');

      // A signed-out caller is unauthenticated, not merely denied.
      const anonymous = await run(h, name, h.anonymous(), input(h));
      expect(anonymous).toMatchObject({ ok: false, error: { code: 'access.unauthenticated' } });
    });
  });

  describe.each(SELLER_CASES)('%s', (name, input) => {
    it('is denied to an admin and to a seller without the seller key, and reaches the use case with it', async () => {
      const h = blogHarness(code);
      const sellerId = h.ids.next<'Seller'>();
      expect(
        await run(
          h,
          name,
          h.admin('everything', [BLOG_POST_EDIT.key, BLOG_POST_PUBLISH.key]),
          input(h),
        ),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(await run(h, name, h.seller(sellerId, []), input(h))).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      const right = await run(h, name, h.seller(sellerId, [BLOG_SELLER_POST_EDIT.key]), input(h));
      expect(right.ok ? 'ok' : right.error?.code).not.toBe('access.denied');
    });
  });

  it('lets a seller key reach nothing of the admin routes', async () => {
    const h = blogHarness(code);
    const sellerId = h.ids.next<'Seller'>();
    h.links.sellerAccess.set(sellerId, true);
    const seller = h.seller(sellerId, [BLOG_SELLER_POST_EDIT.key]);
    for (const [name, , input] of ADMIN_CASES) {
      expect(await run(h, name, seller, input(h))).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
  });

  it('answers the public reads to anyone and the system cases to the system only', async () => {
    const h = blogHarness(code);
    for (const context of [h.anonymous(), h.admin('reader', [])]) {
      expect((await h.cases.viewPublishedPosts.execute(context, {})).ok).toBe(true);
      expect((await h.cases.viewUpcomingEvents.execute(context, undefined)).ok).toBe(true);
      expect((await h.cases.viewPublicTaxonomy.execute(context, {})).ok).toBe(true);
    }
    expect((await h.cases.publishDue.execute(h.system(), undefined)).ok).toBe(true);
    for (const context of [h.anonymous(), h.admin('everything', [BLOG_POST_PUBLISH.key])]) {
      expect(await h.cases.publishDue.execute(context, undefined)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const delivery = { eventId: 'e', subscriber: 'blog.pause-seller-posts' } as never;
    const input = {
      delivery,
      sellerId: h.ids.next<'Seller'>(),
      enabled: false,
      unpublishLive: true,
    };
    expect(await h.cases.pauseSellerPosts.execute(h.admin('x', []), input)).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  describe('separation of duties', () => {
    const solo = (h: Harness) => h.admin('solo', [...WRITER, ...REVIEWER, ...PUBLISHER]);

    it('lets someone other than the writer and the sender approve', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const post = await createNews(h, h.admin('writer', WRITER), category);
      unwrap(await h.cases.submitPost.execute(h.admin('sender', WRITER), { post: post.id }));
      const approved = unwrap(
        await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
          post: post.id,
          body: { versionNo: 1 },
        }),
      );
      expect(approved.open).toMatchObject({ state: 'approved', selfApproved: false });
    });

    it('refuses the sender and the writer who also hold the review key', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const post = await createNews(h, h.admin('writer', [...WRITER, ...REVIEWER]), category);
      unwrap(
        await h.cases.submitPost.execute(h.admin('sender', [...WRITER, ...REVIEWER]), {
          post: post.id,
        }),
      );
      for (const name of ['writer', 'sender']) {
        const refused = refusal(
          await h.cases.approvePost.execute(h.admin(name, [...WRITER, ...REVIEWER]), {
            post: post.id,
            body: { versionNo: 1 },
          }),
        );
        expect(refused.code).toBe(
          code === 'AU' ? 'second-factor.required' : 'blog.self-approval-refused',
        );
      }
      // Nothing was approved, audited or announced.
      expect(h.repo.allPosts(h.market)[0]?.status).toBe('in_review');
      expect(h.audits.map((a) => a.action)).not.toContain('blog.post.approve');
    });

    it('keeps the author and the editing reviewer from approving a reviewer-edited version', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const keys = [...WRITER, ...REVIEWER];
      const post = await createNews(h, h.admin('writer', keys), category);
      unwrap(await h.cases.submitPost.execute(h.admin('sender', WRITER), { post: post.id }));
      unwrap(
        await h.cases.reviewerEdit.execute(h.admin('editor', REVIEWER), {
          post: post.id,
          body: { content: content({ categoryId: category, title: 'Reviewer wording' }) },
        }),
      );
      for (const name of ['writer', 'editor']) {
        const refused = refusal(
          await h.cases.approvePost.execute(h.admin(name, keys), {
            post: post.id,
            body: { versionNo: 2 },
          }),
        );
        expect(refused.code).toBe(
          code === 'AU' ? 'second-factor.required' : 'blog.self-approval-refused',
        );
      }
      const approved = unwrap(
        await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
          post: post.id,
          body: { versionNo: 2 },
        }),
      );
      expect(approved.open).toMatchObject({ state: 'approved', selfApproved: false });
    });

    if (code === 'AU') {
      it('allows a self-approval after a fresh step-up, once, and audits it as one', async () => {
        const h = blogHarness('AU');
        const category = await aCategory(h);
        const post = await createNews(h, solo(h), category);
        unwrap(await h.cases.submitPost.execute(solo(h), { post: post.id }));

        const without = refusal(
          await h.cases.approvePost.execute(solo(h), { post: post.id, body: { versionNo: 1 } }),
        );
        expect(without).toEqual({
          code: 'second-factor.required',
          actionKey: 'blog.post.self-approve',
        });

        h.proof(solo(h));
        const approved = unwrap(
          await h.cases.approvePost.execute(solo(h), { post: post.id, body: { versionNo: 1 } }),
        );
        expect(approved.open).toMatchObject({ state: 'approved', selfApproved: true });
        const entry = h.audits.find((a) => a.action === 'blog.post.approve');
        expect(entry?.after).toMatchObject({ selfApproved: true });
        expect(entry?.after).toHaveProperty('stepUpVerifiedAt');
      });

      it('spends the proof only in the unit that approves: a refused approval keeps it', async () => {
        const h = blogHarness('AU');
        const category = await aCategory(h);
        const post = await createNews(h, solo(h), category);
        unwrap(await h.cases.submitPost.execute(solo(h), { post: post.id }));
        h.proof(solo(h));
        // A stale version is refused before the proof is spent, so the proof is still there.
        expect(
          refusal(
            await h.cases.approvePost.execute(solo(h), { post: post.id, body: { versionNo: 9 } }),
          ).code,
        ).toBe('conflict.stale');
        const approved = unwrap(
          await h.cases.approvePost.execute(solo(h), { post: post.id, body: { versionNo: 1 } }),
        );
        expect(approved.status).toBe('approved');
        // The proof is gone: the next self-approval asks again.
        const second = await createNews(h, solo(h), category, 'Another post');
        unwrap(await h.cases.submitPost.execute(solo(h), { post: second.id }));
        expect(
          refusal(
            await h.cases.approvePost.execute(solo(h), { post: second.id, body: { versionNo: 1 } }),
          ).code,
        ).toBe('second-factor.required');
      });
    } else {
      it('never allows a self-approval where the Market does not, even with a fresh step-up', async () => {
        const h = blogHarness('ZZ');
        const category = await aCategory(h);
        const post = await createNews(h, solo(h), category);
        unwrap(await h.cases.submitPost.execute(solo(h), { post: post.id }));
        h.proof(solo(h));
        expect(
          refusal(
            await h.cases.approvePost.execute(solo(h), { post: post.id, body: { versionNo: 1 } }),
          ).code,
        ).toBe('blog.self-approval-refused');
      });
    }

    it('keeps the publish key apart from the review key', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const approved = await approvedNews(h, category);
      // A reviewer cannot publish what it approved, and a publisher cannot approve.
      expect(
        refusal(
          await h.cases.publishPost.execute(h.admin('reviewer', REVIEWER), {
            post: approved.id,
            body: { versionNo: 1 },
          }),
        ).code,
      ).toBe('access.denied');
      const post = await createNews(h, h.admin('writer', WRITER), category, 'Second');
      unwrap(await h.cases.submitPost.execute(h.admin('writer', WRITER), { post: post.id }));
      expect(
        refusal(
          await h.cases.approvePost.execute(h.admin('publisher', PUBLISHER), {
            post: post.id,
            body: { versionNo: 1 },
          }),
        ).code,
      ).toBe('access.denied');
    });
  });

  describe('a seller key and the seller switch', () => {
    const SELLER: Id<'Seller'> = '0197b000-0000-7000-8000-0000000000bb' as Id<'Seller'>;

    it('is refused on every seller route while the switch is off, and works once it is on', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const seller = h.seller(SELLER, SELLER_KEYS);
      const createInput = { body: { kind: 'news', content: content({ categoryId: category }) } };
      for (const [name, input] of [
        ['sellerListPosts', {}],
        ['sellerViewPost', { post: POST }],
        ['sellerCreatePost', createInput],
        ['sellerUpdateDraft', { post: POST, body: { content: {} } }],
        ['sellerSubmitPost', { post: POST }],
        ['sellerArchivePost', { post: POST }],
        ['sellerChangeEventStatus', { post: POST, body: { status: 'cancelled' } }],
      ] as const) {
        expect(await run(h, name, seller, input)).toMatchObject({
          ok: false,
          error: { code: 'blog.access-off' },
        });
      }
      expect(h.repo.allPosts(h.market)).toEqual([]);

      h.links.sellerAccess.set(SELLER, true);
      const created = unwrap(await h.cases.sellerCreatePost.execute(seller, createInput));
      expect(created).toMatchObject({ ownerType: 'seller', sellerId: SELLER, status: 'draft' });
    });

    it('is refused, not read as on, when the switch cannot be read', async () => {
      const h = blogHarness(code);
      h.links.sellerAccess.set(SELLER, true);
      h.links.accessDown = true;
      expect(
        refusal(await h.cases.sellerListPosts.execute(h.seller(SELLER, SELLER_KEYS), {})).code,
      ).toBe('blog.unavailable');
    });

    it('keeps an admin from approving, publishing, scheduling or resuming a post of a seller whose switch is off', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      h.links.sellerAccess.set(SELLER, true);
      const seller = h.seller(SELLER, SELLER_KEYS);
      h.links.onSale.set('0197b000-0000-7000-8000-00000000000a', new Set([SELLER]));
      const created = unwrap(
        await h.cases.sellerCreatePost.execute(seller, {
          body: {
            kind: 'product',
            content: content({
              categoryId: category,
              links: [{ type: 'product', id: '0197b000-0000-7000-8000-00000000000a' }],
            }),
          },
        }),
      );
      unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: created.id }));
      h.links.sellerAccess.set(SELLER, false);
      expect(
        refusal(
          await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
            post: created.id,
            body: { versionNo: 1 },
          }),
        ).code,
      ).toBe('blog.access-off');
      h.links.sellerAccess.set(SELLER, true);
      unwrap(
        await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
          post: created.id,
          body: { versionNo: 1 },
        }),
      );
      h.links.sellerAccess.set(SELLER, false);
      const publisher = h.admin('publisher', PUBLISHER);
      for (const result of [
        await h.cases.publishPost.execute(publisher, { post: created.id, body: { versionNo: 1 } }),
        await h.cases.schedulePost.execute(publisher, {
          post: created.id,
          body: { versionNo: 1, scheduledAt: h.clock.now().add({ hours: 1 }).toString() },
        }),
      ]) {
        expect(refusal(result).code).toBe('blog.access-off');
      }
    });
  });
});
