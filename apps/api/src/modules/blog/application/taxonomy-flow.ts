import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  BlogCategoryDeleted,
  BlogCategorySaved,
  BlogTagDeleted,
  BlogTagSaved,
} from '../domain/audit';
import { isUuid } from '../domain/fields';
import { MAX_CATEGORIES, MAX_TAGS, parseCategory, parseTag } from '../domain/taxonomy';
import type { BlogDependencies } from './blog-dependencies';
import { invalid } from './failures';
import type { BlogFailure } from './failures';
import { adminOf, fieldsOf, policyOf } from './post-support';
import type { CategoryId, CategoryRecord, Stamp, TagId, TagRecord } from './ports/blog.repository';

// Categories and tags of a Market: the editors' vocabulary. A category's address never changes;
// one in use by a post (any version) cannot be deleted. Everything is audited.

export interface TaxonomyView {
  readonly categories: readonly {
    readonly id: string;
    readonly slug: string;
    readonly position: number;
    readonly names: Readonly<Record<string, string>>;
  }[];
  readonly tags: readonly { readonly id: string; readonly slug: string; readonly name: string }[];
}

const categoryView = (category: CategoryRecord) => ({
  id: category.id as string,
  slug: category.slug,
  position: category.position,
  names: Object.fromEntries(category.names),
});

export async function listTaxonomy(
  deps: BlogDependencies,
  context: CallContext,
): Promise<Result<TaxonomyView, BlogFailure>> {
  const { actor, market } = context;
  if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
  return deps.unitOfWork.run<TaxonomyView, BlogFailure>(
    market,
    async () =>
      ok({
        categories: (await deps.posts.listCategories(market)).map(categoryView),
        tags: (await deps.posts.listTags(market)).map((tag) => ({
          id: tag.id,
          slug: tag.slug,
          name: tag.name,
        })),
      }),
    { readOnly: true },
  );
}

type CategoryView = ReturnType<typeof categoryView>;

export async function createCategory(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly body: unknown },
): Promise<Result<CategoryView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const parsed = parseCategory(input?.body, policy, { slug: 'required' });
  if (parsed.category === null) return err(fieldsOf(parsed.problems));
  const draft = parsed.category;
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<CategoryView, BlogFailure>(market, async () => {
    if ((await deps.posts.findCategoryBySlug(market, draft.slug)) !== null) {
      return err({ code: 'blog.category-slug-taken' });
    }
    if ((await deps.posts.listCategories(market)).length >= MAX_CATEGORIES) {
      return err(invalid('slug', 'limit'));
    }
    const record: CategoryRecord = {
      id: deps.ids.next<'BlogCategory'>(),
      slug: draft.slug,
      position: draft.position,
      names: draft.names,
    };
    await deps.posts.insertCategory(market, record, stamp);
    await deps.audit.record(
      context,
      BlogCategorySaved.entry(record.id, {
        after: { created: true, localeCount: draft.names.size },
      }),
    );
    return ok(categoryView(record));
  });
}

export async function updateCategory(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly category: unknown; readonly body: unknown },
): Promise<Result<CategoryView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  if (!isUuid(input?.category)) return err({ code: 'blog.category-not-found' });
  const id = input.category as CategoryId;
  const parsed = parseCategory(input.body, policy, { slug: 'forbidden' });
  if (parsed.category === null) return err(fieldsOf(parsed.problems));
  const draft = parsed.category;
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<CategoryView, BlogFailure>(market, async () => {
    const found = await deps.posts.findCategory(market, id);
    if (found === null) return err({ code: 'blog.category-not-found' });
    await deps.posts.updateCategory(
      market,
      id,
      { position: draft.position, names: draft.names },
      stamp,
    );
    await deps.audit.record(
      context,
      BlogCategorySaved.entry(id, { after: { created: false, localeCount: draft.names.size } }),
    );
    return ok(categoryView({ ...found, position: draft.position, names: draft.names }));
  });
}

export async function deleteCategory(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly category: unknown },
): Promise<Result<{ readonly deleted: true }, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const { market } = context;
  if (!isUuid(input?.category)) return err({ code: 'blog.category-not-found' });
  const id = input.category as CategoryId;
  return deps.unitOfWork.run<{ readonly deleted: true }, BlogFailure>(market, async () => {
    if ((await deps.posts.findCategory(market, id)) === null) {
      return err({ code: 'blog.category-not-found' });
    }
    if (await deps.posts.categoryInUse(market, id)) return err({ code: 'blog.category-in-use' });
    await deps.posts.deleteCategory(market, id);
    await deps.audit.record(context, BlogCategoryDeleted.entry(id, { after: { deleted: true } }));
    return ok({ deleted: true });
  });
}

type TagView = { readonly id: string; readonly slug: string; readonly name: string };

export async function createTag(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly body: unknown },
): Promise<Result<TagView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const parsed = parseTag(input?.body);
  if (parsed.tag === null) return err(fieldsOf(parsed.problems));
  const draft = parsed.tag;
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<TagView, BlogFailure>(market, async () => {
    if ((await deps.posts.findTagBySlug(market, draft.slug)) !== null) {
      return err({ code: 'blog.tag-slug-taken' });
    }
    if ((await deps.posts.listTags(market)).length >= MAX_TAGS)
      return err(invalid('name', 'limit'));
    const record: TagRecord = {
      id: deps.ids.next<'BlogTag'>(),
      slug: draft.slug,
      name: draft.name,
    };
    await deps.posts.insertTag(market, record, stamp);
    await deps.audit.record(context, BlogTagSaved.entry(record.id, { after: { created: true } }));
    return ok({ id: record.id, slug: record.slug, name: record.name });
  });
}

export async function deleteTag(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly tag: unknown },
): Promise<Result<{ readonly deleted: true }, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const { market } = context;
  if (!isUuid(input?.tag)) return err({ code: 'blog.tag-not-found' });
  const id = input.tag as TagId;
  return deps.unitOfWork.run<{ readonly deleted: true }, BlogFailure>(market, async () => {
    const found = await deps.posts.findTags(market, [id]);
    if (found.length === 0) return err({ code: 'blog.tag-not-found' });
    if (await deps.posts.tagInUse(market, id)) return err({ code: 'blog.tag-in-use' });
    await deps.posts.deleteTag(market, id);
    await deps.audit.record(context, BlogTagDeleted.entry(id, { after: { deleted: true } }));
    return ok({ deleted: true });
  });
}
