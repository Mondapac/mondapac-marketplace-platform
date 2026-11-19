import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { POST_KINDS } from '../domain/content';
import type { PostKind } from '../domain/content';
import { POST_STATUSES } from '../domain/lifecycle';
import type { PostStatus } from '../domain/lifecycle';
import type { BlogDependencies } from './blog-dependencies';
import { requireSellerAccess } from './edit-flow';
import type { BlogFailure } from './failures';
import {
  adminOf,
  detailOf,
  fieldsOf,
  loadPost,
  ownedBy,
  sellerOf,
  summaryView,
} from './post-support';
import type { PostDetailView, PostSummaryView } from './post-support';
import type { PostFilter } from './ports/blog.repository';
import { closedObject, problem } from '../domain/fields';
import type { Problems } from '../domain/fields';

// The reads of the editors' side: the list of posts and one post with its versions. Admin reads
// reach every post of the Market; a seller reads only its own, and only while its blog switch is on.

export const LIST_PAGE_SIZE = 50;

export interface PostPage {
  readonly items: readonly PostSummaryView[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

function pageOf(problems: Problems, value: unknown): number {
  if (value === undefined) return 1;
  const parsed = typeof value === 'string' && /^\d{1,4}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    problem(problems, 'page', 'value');
    return 1;
  }
  return parsed;
}

function parseFilter(query: unknown): {
  readonly filter: PostFilter;
  readonly page: number;
  readonly problems: Problems;
} {
  const problems: Problems = [];
  let filter: PostFilter = {};
  let page = 1;
  const q = query ?? {};
  if (!closedObject(problems, '', q, ['status', 'kind', 'page'])) {
    return { filter, page, problems };
  }
  if (q.status !== undefined) {
    if ((POST_STATUSES as readonly unknown[]).includes(q.status)) {
      filter = { ...filter, statuses: [q.status as PostStatus] };
    } else problem(problems, 'status', 'value');
  }
  if (q.kind !== undefined) {
    if ((POST_KINDS as readonly unknown[]).includes(q.kind))
      filter = { ...filter, kind: q.kind as PostKind };
    else problem(problems, 'kind', 'value');
  }
  page = pageOf(problems, q.page);
  return { filter, page, problems };
}

async function listFor(
  deps: BlogDependencies,
  context: CallContext,
  filter: PostFilter,
  page: number,
): Promise<Result<PostPage, BlogFailure>> {
  const { market } = context;
  return deps.unitOfWork.run<PostPage, BlogFailure>(
    market,
    async () => {
      const rows = await deps.posts.listPosts(market, filter, {
        limit: LIST_PAGE_SIZE + 1,
        offset: (page - 1) * LIST_PAGE_SIZE,
      });
      return ok({
        items: rows
          .slice(0, LIST_PAGE_SIZE)
          .map((row) => summaryView(row.post, row.title, row.openState)),
        page,
        pageSize: LIST_PAGE_SIZE,
        hasMore: rows.length > LIST_PAGE_SIZE,
      });
    },
    { readOnly: true },
  );
}

/** The seller's own posts. */
export async function listPostsForSeller(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly query?: unknown },
): Promise<Result<PostPage, BlogFailure>> {
  const seller = sellerOf(context);
  if (seller === null) return err({ code: 'access.denied' });
  const refused = await requireSellerAccess(deps, context, seller.sellerId);
  if (refused !== null) return err(refused);
  const parsed = parseFilter(input?.query);
  if (parsed.problems.length > 0) return err(fieldsOf(parsed.problems));
  return listFor(
    deps,
    context,
    { ...parsed.filter, ownerType: 'seller', sellerId: seller.sellerId },
    parsed.page,
  );
}

/** One post with its working version, its live version and the version list. */
export async function viewPostForAdmin(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
): Promise<Result<PostDetailView, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const { market } = context;
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(
    market,
    async () => {
      const loaded = await loadPost(deps, market, input?.post);
      if (!loaded.ok) return err(loaded.error);
      return ok(await detailOf(deps, market, loaded.value, true));
    },
    { readOnly: true },
  );
}

/** One of the seller's own posts; any other post is not found. */
export async function viewPostForSeller(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
): Promise<Result<PostDetailView, BlogFailure>> {
  const seller = sellerOf(context);
  if (seller === null) return err({ code: 'access.denied' });
  const refused = await requireSellerAccess(deps, context, seller.sellerId);
  if (refused !== null) return err(refused);
  const { market } = context;
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(
    market,
    async () => {
      const loaded = await loadPost(deps, market, input?.post);
      if (!loaded.ok) return err(loaded.error);
      if (!ownedBy(loaded.value.post, seller)) return err({ code: 'blog.post-not-found' });
      return ok(await detailOf(deps, market, loaded.value, false));
    },
    { readOnly: true },
  );
}
