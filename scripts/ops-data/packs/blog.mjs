// The platform's blog (scenarios/<market>/content.mjs, `blog`), through the admin's blog editor:
// categories, a cover picture per post, and posts the platform admin writes and submits; the
// reviewer admin approves and publishes them (an author never approves their own post). A rerun
// changes nothing: a post is found by its address (slug).
import { banner } from '../media.mjs';

/** The post body in the API's shape: keys of the scenario become the ids the loader made. */
function bodyOf(post, state) {
  return post.body.map((block) => {
    if (block.type === 'product_cards') {
      return {
        type: 'product_cards',
        productIds: block.products.map((key) => {
          const known = state.products?.[key];
          if (known === undefined) throw new Error(`blog post ${post.slug}: no product ${key}`);
          return known.productId;
        }),
      };
    }
    if (block.type === 'seller_card') {
      const known = state.sellers?.[block.seller];
      if (known === undefined) throw new Error(`blog post ${post.slug}: no seller ${block.seller}`);
      return { type: 'seller_card', sellerId: known.sellerId };
    }
    return block;
  });
}

async function ensureCategories(admin, blog, locale) {
  const taxonomy = await admin.ok('GET', '/blog/admin/taxonomy');
  const ids = new Map(taxonomy.categories.map((category) => [category.slug, category.id]));
  for (const [index, category] of blog.categories.entries()) {
    if (ids.has(category.slug)) continue;
    const made = await admin.ok('POST', '/blog/admin/taxonomy/categories', {
      slug: category.slug,
      names: { [locale]: category.name },
      position: index,
    });
    ids.set(category.slug, made.id);
  }
  return ids;
}

/** Every page of the admin's post list. */
async function allPosts(admin) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const list = await admin.ok('GET', `/blog/admin/posts?page=${page}&pageSize=50`);
    rows.push(...list.items);
    if (!list.hasMore || list.items.length === 0) return rows;
  }
}

/** The number of the post's newest version, the one the reviewer read. */
const versionOf = (detail) => Math.max(...detail.versions.map((version) => version.versionNo));

export async function blogPack({ admin, reviewer, scenario, state, log }) {
  const blog = scenario.content.blog;
  const categories = await ensureCategories(admin, blog, scenario.locale);
  const existing = await allPosts(admin);
  let made = 0;
  let published = 0;
  for (const post of blog.posts) {
    let row = existing.find((item) => item.slug === post.slug);
    let detail;
    if (row === undefined) {
      const cover = await admin.ok('POST', '/blog/admin/media', { data: await banner(post.cover) });
      detail = await admin.ok('POST', '/blog/admin/posts', {
        kind: post.kind,
        slug: post.slug,
        content: {
          title: post.title,
          excerpt: post.excerpt,
          body: bodyOf(post, state),
          coverImageId: cover.id,
          coverAlt: post.coverAlt,
          authorDisplay: 'The Mondapac team',
          categoryId: categories.get(post.category),
        },
      });
      made += 1;
    } else {
      detail = await admin.ok('GET', `/blog/admin/posts/${row.id}`);
    }
    const id = detail.id;
    if (detail.status === 'draft') {
      detail = await admin.ok('POST', `/blog/admin/posts/${id}/submit`, {});
    }
    if (detail.status === 'in_review') {
      detail = await reviewer.ok('POST', `/blog/admin/posts/${id}/approve`, {
        versionNo: versionOf(detail),
      });
    }
    if (detail.status === 'approved') {
      detail = await reviewer.ok('POST', `/blog/admin/posts/${id}/publish`, {
        versionNo: versionOf(detail),
      });
      published += 1;
    }
    if (post.slug === blog.featured && detail.featured !== true) {
      await reviewer.ok('PUT', `/blog/admin/posts/${id}/featured`, { featured: true });
    }
  }
  log(`  ${blog.posts.length} blog posts (${made} new, ${published} published now)`);
}
