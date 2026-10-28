import type { Id } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  aCategory,
  content,
  PUBLISHER,
  refusal,
  REVIEWER,
  SELLER_KEYS,
  unwrap,
} from '../../../../../test/support/blog-fixtures';
import {
  blogHarness,
  PRODUCT_A,
  PRODUCT_B,
  quietLogs,
  type BlogHarness,
} from '../../../../../test/support/blog-harness';

// A seller's own posts: the switch an admin turns on, the monthly quota counted in the Market's
// time zone, the seller's reach (its own posts and its own products only) and what happens to its
// live posts when the switch is turned off with that request.

quietLogs();

const SELLER = '0197b000-0000-7000-8000-0000000000b1' as Id<'Seller'>;
const OTHER_SELLER = '0197b000-0000-7000-8000-0000000000b2' as Id<'Seller'>;

function sellerWorld(h: BlogHarness) {
  h.links.sellerAccess.set(SELLER, true);
  h.links.sellerAccess.set(OTHER_SELLER, true);
  h.links.onSale.set(PRODUCT_A, new Set([SELLER]));
  h.links.onSale.set(PRODUCT_B, new Set([OTHER_SELLER]));
  return h.seller(SELLER, SELLER_KEYS);
}

const productPost = (categoryId: string, title: string, productId = PRODUCT_A) => ({
  kind: 'product',
  content: content({ categoryId, title, links: [{ type: 'product', id: productId }] }),
});

describe.each([['AU'], ['ZZ']] as const)('seller posts in %s', (code) => {
  it('writes and sends its own post for review, and an admin approves and publishes it', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const seller = sellerWorld(h);
    const created = unwrap(
      await h.cases.sellerCreatePost.execute(seller, { body: productPost(category, 'Our dates') }),
    );
    expect(created).toMatchObject({ ownerType: 'seller', sellerId: SELLER, kind: 'product' });
    // A seller's view carries no account ids.
    expect(created.open?.people).toBeNull();

    const sent = unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: created.id }));
    expect(sent.status).toBe('in_review');

    const approved = unwrap(
      await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
        post: created.id,
        body: { versionNo: 1 },
      }),
    );
    expect(approved.status).toBe('approved');
    unwrap(
      await h.cases.publishPost.execute(h.admin('publisher', PUBLISHER), {
        post: created.id,
        body: { versionNo: 1 },
      }),
    );
    const answer = unwrap(
      await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: created.slug }),
    );
    // The public post names the seller (by id) and gives no byline of the platform.
    expect(answer).toMatchObject({ post: { sellerId: SELLER, authorDisplay: null } });
  });

  it('reaches only its own posts: another seller or an admin post is not found, byte for byte', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const seller = sellerWorld(h);
    const own = unwrap(
      await h.cases.sellerCreatePost.execute(seller, { body: productPost(category, 'Mine') }),
    );
    const other = unwrap(
      await h.cases.sellerCreatePost.execute(h.seller(OTHER_SELLER, SELLER_KEYS), {
        body: productPost(category, 'Theirs', PRODUCT_B),
      }),
    );
    const platform = unwrap(
      await h.cases.createPost.execute(h.admin('writer', ['blog.post.edit']), {
        body: { kind: 'news', content: content({ categoryId: category }) },
      }),
    );
    const missing = refusal(
      await h.cases.sellerViewPost.execute(seller, {
        post: '0197b000-0000-7000-8000-0000000000fe',
      }),
    );
    for (const post of [other.id, platform.id]) {
      expect(refusal(await h.cases.sellerViewPost.execute(seller, { post }))).toEqual(missing);
      expect(
        refusal(
          await h.cases.sellerUpdateDraft.execute(seller, {
            post,
            body: { content: content({ categoryId: category }) },
          }),
        ),
      ).toEqual(missing);
      expect(refusal(await h.cases.sellerSubmitPost.execute(seller, { post }))).toEqual(missing);
      expect(refusal(await h.cases.sellerArchivePost.execute(seller, { post }))).toEqual(missing);
    }
    const list = unwrap(await h.cases.sellerListPosts.execute(seller, {}));
    expect(list.items.map((i) => i.id)).toEqual([own.id]);
  });

  it('links only its own on-sale products, and only product, seller and brand links', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const seller = sellerWorld(h);
    const post = unwrap(
      await h.cases.sellerCreatePost.execute(seller, {
        body: productPost(category, 'Their product', PRODUCT_B),
      }),
    );
    const refused = refusal(await h.cases.sellerSubmitPost.execute(seller, { post: post.id }));
    expect(
      (refused as unknown as { findings: { code: string }[] }).findings.map((f) => f.code),
    ).toContain('product-not-own');

    const withPage = refusal(
      await h.cases.sellerCreatePost.execute(seller, {
        body: {
          kind: 'product',
          content: content({ categoryId: category, links: [{ type: 'page', id: PRODUCT_A }] }),
        },
      }),
    );
    expect(withPage.code).toBe('validation.failed');
    const withByline = refusal(
      await h.cases.sellerCreatePost.execute(seller, {
        body: {
          kind: 'news',
          content: content({ categoryId: category, extra: { authorDisplay: 'Platform' } }),
        },
      }),
    );
    expect(withByline.code).toBe('validation.failed');
  });

  it('refuses a send while the catalog cannot say which products are on sale', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const seller = sellerWorld(h);
    const post = unwrap(
      await h.cases.sellerCreatePost.execute(seller, { body: productPost(category, 'Dates') }),
    );
    h.links.productsDown = true;
    const refused = refusal(await h.cases.sellerSubmitPost.execute(seller, { post: post.id }));
    expect(
      (refused as unknown as { findings: { code: string }[] }).findings.map((f) => f.code),
    ).toContain('products-unverifiable');
  });

  describe('the monthly quota', () => {
    const limitOf = (h: BlogHarness) => h.deps.policy.of(h.market)!.sellerPostsPerMonth;

    it('uses one unit at the first send of a post, none at a re-send, and refuses past the limit', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const seller = sellerWorld(h);
      const limit = limitOf(h);
      expect(limit).toBe(code === 'AU' ? 4 : 2);

      const first = unwrap(
        await h.cases.sellerCreatePost.execute(seller, { body: productPost(category, 'Post 0') }),
      );
      // Writing drafts uses nothing.
      for (let n = 1; n <= limit + 2; n += 1) {
        unwrap(
          await h.cases.sellerCreatePost.execute(seller, {
            body: productPost(category, `Draft ${n}`),
          }),
        );
      }
      const period = unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: first.id }));
      expect(period.quotaPeriod).toMatch(/^2026-10$/);
      expect(await h.repo.quotaUsed(h.market, SELLER, '2026-10')).toBe(1);

      // Sent back and sent again: the same post, the same unit.
      unwrap(
        await h.cases.requestChanges.execute(h.admin('reviewer', REVIEWER), {
          post: first.id,
          body: { versionNo: 1, note: 'Add a sentence.' },
        }),
      );
      unwrap(
        await h.cases.sellerUpdateDraft.execute(seller, {
          post: first.id,
          body: {
            content: content({
              categoryId: category,
              title: 'Post 0 again',
              links: [{ type: 'product', id: PRODUCT_A }],
            }),
          },
        }),
      );
      unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: first.id }));
      expect(await h.repo.quotaUsed(h.market, SELLER, '2026-10')).toBe(1);

      // The other drafts use the rest of the month, then the next one is refused.
      const drafts = h.repo.allPosts(h.market).filter((p) => p.status === 'draft');
      for (const draft of drafts.slice(0, limit - 1)) {
        unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: draft.id }));
      }
      expect(await h.repo.quotaUsed(h.market, SELLER, '2026-10')).toBe(limit);
      const over = refusal(
        await h.cases.sellerSubmitPost.execute(seller, { post: drafts[limit - 1]!.id }),
      );
      expect(over).toEqual({ code: 'blog.quota-used' });
      // The refused send left the post a draft and used nothing.
      expect(h.repo.allPosts(h.market).find((p) => p.id === drafts[limit - 1]!.id)?.status).toBe(
        'draft',
      );
      expect(await h.repo.quotaUsed(h.market, SELLER, '2026-10')).toBe(limit);

      // Another seller has its own count.
      const otherSeller = h.seller(OTHER_SELLER, SELLER_KEYS);
      const theirs = unwrap(
        await h.cases.sellerCreatePost.execute(otherSeller, {
          body: productPost(category, 'Theirs', PRODUCT_B),
        }),
      );
      expect(
        unwrap(await h.cases.sellerSubmitPost.execute(otherSeller, { post: theirs.id })).status,
      ).toBe('in_review');

      // A new month starts again.
      h.clock.advance(Temporal.Duration.from({ hours: 24 * 31 }));
      expect(
        unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: drafts[limit - 1]!.id }))
          .quotaPeriod,
      ).toBe('2026-11');
    });

    it("counts the month in the Market's time zone, not in UTC", async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const seller = sellerWorld(h);
      // 2026-10-31T14:30Z is already 1 November in Brisbane (UTC+10) and still 31 October at 23:30
      // in Tokyo (UTC+9).
      h.clock.set(Temporal.Instant.from('2026-10-31T14:30:00Z'));
      const post = unwrap(
        await h.cases.sellerCreatePost.execute(seller, { body: productPost(category, 'Boundary') }),
      );
      const sent = unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: post.id }));
      expect(sent.quotaPeriod).toBe(code === 'AU' ? '2026-11' : '2026-10');
    });

    it('lets a platform post be sent with no quota', async () => {
      const h = blogHarness(code);
      const category = await aCategory(h);
      const post = unwrap(
        await h.cases.createPost.execute(h.admin('writer', ['blog.post.edit']), {
          body: { kind: 'news', content: content({ categoryId: category }) },
        }),
      );
      const sent = unwrap(
        await h.cases.submitPost.execute(h.admin('writer', ['blog.post.edit']), { post: post.id }),
      );
      expect(sent.quotaPeriod).toBeNull();
    });
  });

  describe('turning the switch off', () => {
    async function livePost(h: BlogHarness) {
      const category = await aCategory(h);
      const seller = sellerWorld(h);
      const created = unwrap(
        await h.cases.sellerCreatePost.execute(seller, {
          body: productPost(category, 'Going live'),
        }),
      );
      unwrap(await h.cases.sellerSubmitPost.execute(seller, { post: created.id }));
      unwrap(
        await h.cases.approvePost.execute(h.admin('reviewer', REVIEWER), {
          post: created.id,
          body: { versionNo: 1 },
        }),
      );
      unwrap(
        await h.cases.publishPost.execute(h.admin('publisher', PUBLISHER), {
          post: created.id,
          body: { versionNo: 1 },
        }),
      );
      return created;
    }
    const delivery = (n: number) =>
      ({
        eventId: `0197b000-0000-7000-8000-0000000001${n}0`,
        subscriber: 'blog.pause-seller-posts',
      }) as never;

    it('leaves live posts on the site unless the admin asked for them to come down', async () => {
      const h = blogHarness(code);
      const created = await livePost(h);
      h.links.sellerAccess.set(SELLER, false);
      const kept = unwrap(
        await h.cases.pauseSellerPosts.execute(h.system(), {
          delivery: delivery(1),
          sellerId: SELLER,
          enabled: false,
          unpublishLive: false,
        }),
      );
      expect(kept).toEqual({ paused: 0 });
      expect(h.repo.allPosts(h.market).find((p) => p.id === created.id)?.status).toBe('published');
    });

    it('pauses the live posts when asked, once per delivery, and not when the switch is on again', async () => {
      const h = blogHarness(code);
      const created = await livePost(h);
      h.links.sellerAccess.set(SELLER, false);
      const input = {
        delivery: delivery(2),
        sellerId: SELLER,
        enabled: false,
        unpublishLive: true,
      };
      expect(unwrap(await h.cases.pauseSellerPosts.execute(h.system(), input))).toMatchObject({
        paused: 1,
      });
      const paused = h.repo.allPosts(h.market).find((p) => p.id === created.id);
      expect(paused).toMatchObject({ status: 'unpublished' });
      expect(paused?.pausedReason).toMatch(/blog access/i);
      expect(
        refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: created.slug }))
          .code,
      ).toBe('blog.gone');
      const events = h.events.length;
      // The same delivery again changes nothing.
      expect(unwrap(await h.cases.pauseSellerPosts.execute(h.system(), input))).toMatchObject({
        paused: 0,
      });
      expect(h.events).toHaveLength(events);

      // A late delivery of the old request after the switch was turned on again does nothing.
      h.links.sellerAccess.set(SELLER, true);
      const resumed = unwrap(
        await h.cases.resumePost.execute(h.admin('publisher', PUBLISHER), { post: created.id }),
      );
      expect(resumed.status).toBe('published');
      expect(
        unwrap(
          await h.cases.pauseSellerPosts.execute(h.system(), { ...input, delivery: delivery(3) }),
        ),
      ).toMatchObject({ paused: 0 });
      expect(h.repo.allPosts(h.market).find((p) => p.id === created.id)?.status).toBe('published');
    });
  });

  it('archives its own post and cannot change an event status of a post that is not an event', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const seller = sellerWorld(h);
    const created = unwrap(
      await h.cases.sellerCreatePost.execute(seller, { body: productPost(category, 'Short') }),
    );
    expect(
      refusal(
        await h.cases.sellerChangeEventStatus.execute(seller, {
          post: created.id,
          body: { status: 'cancelled' },
        }),
      ).code,
    ).toMatch(/^(blog\.wrong-state|validation\.failed)$/);
    const archived = unwrap(await h.cases.sellerArchivePost.execute(seller, { post: created.id }));
    expect(archived.status).toBe('archived');
  });
});
