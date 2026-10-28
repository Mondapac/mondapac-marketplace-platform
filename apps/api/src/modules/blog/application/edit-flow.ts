import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { BlogPostCreated, BlogPostDraftSaved } from '../domain/audit';
import { copyContent } from '../domain/copy';
import type { CopyPackage } from '../domain/copy';
import { parsePostContent, POST_KINDS } from '../domain/content';
import type { OwnerType, PostKind } from '../domain/content';
import { BlogPostEditedByReviewer } from '../domain/events';
import { closedObject, problem } from '../domain/fields';
import type { Problems } from '../domain/fields';
import { editModeOf, refusalFor, statusAfter } from '../domain/lifecycle';
import { MAX_SLUG_ATTEMPTS, parsePostSlug, slugFromTitle, slugWithSuffix } from '../domain/slug';
import type { BlogDependencies } from './blog-dependencies';
import { invalid } from './failures';
import type { BlogFailure } from './failures';
import {
  adminOf,
  checkReferences,
  detailOf,
  emit,
  factsOf,
  fieldsOf,
  insertNextVersion,
  loadPost,
  lockPost,
  policyOf,
  sellerOf,
  storedContent,
} from './post-support';
import type { PostDetailView } from './post-support';
import type { PostRecord, Stamp } from './ports/blog.repository';

// The writing side of the blog: a new post, a change to its draft, a reviewer's edit of a version
// in review, and the package that copies a post into another Market. Every change locks the post
// row first and is audited in the same unit. A seller's calls are refused while its blog switch is
// off (read outside any unit, through the sellers facade).

export type Author = 'admin' | 'seller';

/** Admin or seller, and the owner a new post gets. */
function authorOf(
  context: CallContext,
  as: Author,
): {
  readonly accountId: Id<'Account'>;
  readonly ownerType: OwnerType;
  readonly sellerId: Id<'Seller'> | null;
} | null {
  if (as === 'admin') {
    const admin = adminOf(context);
    return admin === null
      ? null
      : { accountId: admin.accountId, ownerType: 'platform', sellerId: null };
  }
  const seller = sellerOf(context);
  return seller === null
    ? null
    : { accountId: seller.accountId, ownerType: 'seller', sellerId: seller.sellerId };
}

/** The seller's switch, read outside any unit: off is `blog.access-off`, unreadable `blog.unavailable`. */
export async function requireSellerAccess(
  deps: BlogDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<BlogFailure | null> {
  const enabled = await deps.links.sellerBlogEnabled(context, sellerId);
  if (!enabled.ok) return { code: 'blog.unavailable' };
  return enabled.value ? null : { code: 'blog.access-off' };
}

const CREATE_FIELDS = ['kind', 'slug', 'content'] as const;

function parseKind(problems: Problems, value: unknown): PostKind | null {
  if (!(POST_KINDS as readonly unknown[]).includes(value)) {
    problem(problems, 'kind', value === undefined ? 'required' : 'value');
    return null;
  }
  return value as PostKind;
}

/** Creates a post with its first draft. Admin: a platform post. Seller: the seller's own. */
export async function createPost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly body: unknown },
  as: Author,
): Promise<Result<PostDetailView, BlogFailure>> {
  const author = authorOf(context, as);
  if (author === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  if (author.sellerId !== null) {
    const refused = await requireSellerAccess(deps, context, author.sellerId);
    if (refused !== null) return err(refused);
  }

  const problems: Problems = [];
  const body = input?.body;
  const allowed: readonly string[] = as === 'admin' ? [...CREATE_FIELDS, 'copied'] : CREATE_FIELDS;
  if (!closedObject(problems, '', body, allowed)) return err(fieldsOf(problems));
  const kind = parseKind(problems, body.kind);
  let typedSlug: string | null = null;
  if (body.slug !== undefined && body.slug !== null) {
    typedSlug = parsePostSlug(problems, 'slug', body.slug);
  }
  if (body.copied !== undefined && typeof body.copied !== 'boolean') {
    problem(problems, 'copied', 'type');
  }
  if (kind === null || problems.length > 0) return err(fieldsOf(problems));
  const parsed = parsePostContent(body.content, {
    kind,
    ownerType: author.ownerType,
    timeZone: policy.timeZone,
  });
  if (parsed.content === null) {
    return err(
      fieldsOf(
        parsed.problems.map((p) => ({ ...p, path: `content${p.path === '' ? '' : `.${p.path}`}` })),
      ),
    );
  }
  const content = parsed.content;
  const baseSlug = typedSlug ?? slugFromTitle(content.title);
  if (baseSlug === '') return err(invalid('slug', 'required'));

  const at = deps.clock.now();
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(market, async () => {
    const references = await checkReferences(deps, market, content);
    if (references.length > 0) {
      return err(fieldsOf(references.map((p) => ({ ...p, path: `content.${p.path}` }))));
    }
    let slug: string | null = null;
    if (typedSlug !== null) {
      slug = (await deps.posts.isSlugFree(market, typedSlug, null)) ? typedSlug : null;
    } else {
      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS && slug === null; attempt += 1) {
        const candidate = attempt === 1 ? baseSlug : slugWithSuffix(baseSlug, attempt);
        if (await deps.posts.isSlugFree(market, candidate, null)) slug = candidate;
      }
    }
    if (slug === null) return err({ code: 'blog.slug-taken' });

    const post: PostRecord = {
      id: deps.ids.next<'BlogPost'>(),
      kind,
      slug,
      ownerType: author.ownerType,
      sellerId: author.sellerId,
      status: 'draft',
      liveVersionId: null,
      draftVersionId: null,
      scheduledAt: null,
      scheduledBy: null,
      publishedAt: null,
      unpublishedAt: null,
      pausedReason: null,
      featured: false,
      quotaPeriod: null,
      createdAt: at,
      createdBy: author.accountId,
      updatedAt: at,
      updatedBy: author.accountId,
      rowVersion: 0,
    };
    const versionId = deps.ids.next<'BlogPostVersion'>();
    // The post and its first version point at each other; the database checks the pair at commit.
    await deps.posts.insertPost(market, { ...post, draftVersionId: versionId });
    await deps.posts.insertVersion(market, {
      id: versionId,
      postId: post.id,
      versionNo: 1,
      state: 'draft',
      content: storedContent(content),
      editedByReviewer: false,
      createdAt: at,
      createdBy: author.accountId,
      updatedAt: at,
      submittedAt: null,
      submittedBy: null,
      decidedAt: null,
      decidedBy: null,
      decision: null,
      decisionNote: null,
      selfApproved: false,
      publishedAt: null,
      publishedBy: null,
    });
    await deps.audit.record(
      context,
      BlogPostCreated.entry(post.id, {
        after: {
          kind,
          ownerType: author.ownerType,
          copied: body.copied === true,
        },
      }),
    );
    const loaded = await loadPost(deps, market, post.id);
    if (!loaded.ok) return err(loaded.error);
    return ok(await detailOf(deps, market, loaded.value, as === 'admin'));
  });
}

const UPDATE_FIELDS = ['content', 'slug'] as const;

/**
 * Saves the draft of a post (the whole content, replaced). A draft is changed in place; a returned
 * or approved version, or a live post, starts a new draft from what was sent. A slug can be
 * changed here only until the post was first on the site (after that: `rename-slug`).
 */
export async function updateDraft(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
  as: Author,
): Promise<Result<PostDetailView, BlogFailure>> {
  const author = authorOf(context, as);
  if (author === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  if (author.sellerId !== null) {
    const refused = await requireSellerAccess(deps, context, author.sellerId);
    if (refused !== null) return err(refused);
  }
  const problems: Problems = [];
  const body = input?.body;
  if (!closedObject(problems, '', body, UPDATE_FIELDS)) return err(fieldsOf(problems));
  let typedSlug: string | null = null;
  if (body.slug !== undefined && body.slug !== null) {
    typedSlug = parsePostSlug(problems, 'slug', body.slug);
  }
  if (problems.length > 0) return err(fieldsOf(problems));

  const at = deps.clock.now();
  const stamp: Stamp = { at, by: author.accountId };
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const access = accessToPost(post, author, as);
    if (access !== null) return err(access);
    const facts = factsOf(post, open);
    const refused = refusalFor('edit', facts);
    if (refused !== null) return err({ code: refused });
    const editMode = editModeOf(facts);
    if (editMode === null) return err({ code: 'blog.wrong-state' });
    // Only the writer of the open draft edits it in place. Anyone else's edit is a new draft version
    // of their own, so the draft's writer list (separation of duties) can never lose a name.
    const mode =
      editMode === 'in-place' && open!.createdBy !== author.accountId ? 'new-draft' : editMode;

    const parsed = parsePostContent(body.content, {
      kind: post.kind,
      ownerType: post.ownerType,
      timeZone: policy.timeZone,
    });
    if (parsed.content === null) {
      return err(
        fieldsOf(
          parsed.problems.map((p) => ({
            ...p,
            path: `content${p.path === '' ? '' : `.${p.path}`}`,
          })),
        ),
      );
    }
    const content = parsed.content;
    const references = await checkReferences(deps, market, content);
    if (references.length > 0) {
      return err(fieldsOf(references.map((p) => ({ ...p, path: `content.${p.path}` }))));
    }
    let slug: string | undefined;
    if (typedSlug !== null && typedSlug !== post.slug) {
      if (post.publishedAt !== null) return err({ code: 'blog.wrong-state' });
      if (!(await deps.posts.isSlugFree(market, typedSlug, post.id))) {
        return err({ code: 'blog.slug-taken' });
      }
      slug = typedSlug;
    }

    let versionNo: number;
    if (mode === 'in-place') {
      await deps.posts.replaceContent(
        market,
        post.id,
        open!.id,
        { ...content, links: [...content.links] },
        at,
      );
      versionNo = open!.versionNo;
      await deps.posts.updatePost(
        market,
        post.id,
        { ...(slug === undefined ? {} : { slug }) },
        stamp,
      );
    } else {
      // The old open version (another writer's draft, returned or approved) is retired first: a
      // post has one open version.
      if (open !== null) {
        await deps.posts.updateVersion(market, post.id, open.id, { state: 'retired' }, at);
      }
      const inserted = await insertNextVersion({
        deps,
        market,
        post,
        content,
        by: author.accountId,
        state: 'draft',
      });
      if (!inserted.ok) return err(inserted.error);
      versionNo = inserted.value.versionNo;
      await deps.posts.updatePost(
        market,
        post.id,
        {
          draftVersionId: inserted.value.id,
          status: statusAfter('new-draft', facts),
          scheduledAt: null,
          ...(slug === undefined ? {} : { slug }),
        },
        stamp,
      );
    }
    await deps.audit.record(
      context,
      BlogPostDraftSaved.entry(post.id, {
        after: { operation: mode === 'in-place' ? 'update' : 'new-draft', versionNo },
      }),
    );
    const reloaded = await loadPost(deps, market, post.id);
    if (!reloaded.ok) return err(reloaded.error);
    return ok(await detailOf(deps, market, reloaded.value, as === 'admin'));
  });
}

/** The refusal of a post a caller may not touch, or null: a seller reaches its own posts only. */
export function accessToPost(
  post: PostRecord,
  author: { readonly sellerId: Id<'Seller'> | null },
  as: Author,
): BlogFailure | null {
  if (as === 'seller') {
    return post.ownerType === 'seller' && post.sellerId === author.sellerId
      ? null
      : { code: 'blog.post-not-found' };
  }
  // An admin edits platform posts; a seller's post is the seller's (a reviewer edits it in review).
  return post.ownerType === 'platform' ? null : { code: 'blog.seller-owned' };
}

/**
 * A reviewer edits the text of a version in review. The edit is a new version, flagged as the
 * reviewer's, that stays in review under the same submitter; the version it replaces is retired.
 * The author is told by an event. The approver must then be someone other than the author, the
 * submitter and this reviewer.
 */
export async function reviewerEdit(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const problems: Problems = [];
  const body = input?.body;
  if (!closedObject(problems, '', body, ['content'])) return err(fieldsOf(problems));
  const at = deps.clock.now();
  const stamp: Stamp = { at, by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const refused = refusalFor('reviewer-edit', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    const parsed = parsePostContent(body.content, {
      kind: post.kind,
      ownerType: post.ownerType,
      timeZone: policy.timeZone,
    });
    if (parsed.content === null) {
      return err(
        fieldsOf(
          parsed.problems.map((p) => ({
            ...p,
            path: `content${p.path === '' ? '' : `.${p.path}`}`,
          })),
        ),
      );
    }
    const references = await checkReferences(deps, market, parsed.content);
    if (references.length > 0) {
      return err(fieldsOf(references.map((p) => ({ ...p, path: `content.${p.path}` }))));
    }
    const previous = open!;
    await deps.posts.updateVersion(market, post.id, previous.id, { state: 'retired' }, at);
    const inserted = await insertNextVersion({
      deps,
      market,
      post,
      content: parsed.content,
      by: admin.accountId,
      state: 'draft',
      editedByReviewer: true,
    });
    if (!inserted.ok) return err(inserted.error);
    // The new version takes the place of the old one in review, under the same submitter.
    await deps.posts.updateVersion(
      market,
      post.id,
      inserted.value.id,
      { state: 'in_review', submittedAt: previous.submittedAt, submittedBy: previous.submittedBy },
      at,
    );
    await deps.posts.updatePost(market, post.id, { draftVersionId: inserted.value.id }, stamp);
    await deps.audit.record(
      context,
      BlogPostDraftSaved.entry(post.id, {
        after: { operation: 'reviewer-edit', versionNo: inserted.value.versionNo },
      }),
    );
    await emit(deps, context, BlogPostEditedByReviewer, post, inserted.value.id);
    const reloaded = await loadPost(deps, market, post.id);
    if (!reloaded.ok) return err(reloaded.error);
    return ok(await detailOf(deps, market, reloaded.value, true));
  });
}

/** What the editor takes to the other Market (see {@link copyContent}). */
export async function prepareCopy(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
): Promise<Result<CopyPackage, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const { market } = context;
  return deps.unitOfWork.run<CopyPackage, BlogFailure>(
    market,
    async () => {
      const loaded = await loadPost(deps, market, input?.post);
      if (!loaded.ok) return err(loaded.error);
      const { post, open } = loaded.value;
      if (post.ownerType !== 'platform') return err({ code: 'blog.seller-owned' });
      const version =
        open ??
        (post.liveVersionId === null
          ? null
          : await deps.posts.findVersion(market, post.id, post.liveVersionId));
      if (version === null) return err({ code: 'blog.wrong-state' });
      return ok(copyContent(post.kind, version.content));
    },
    { readOnly: true },
  );
}
