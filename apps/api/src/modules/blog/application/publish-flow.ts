import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import {
  BlogPostArchived,
  BlogPostEventStatusChanged,
  BlogPostFeatured,
  BlogPostPaused,
  BlogPostPublished,
  BlogPostResumed,
  BlogPostScheduled,
  BlogPostSlugChanged,
} from '../domain/audit';
import { statusMessageFindings } from '../domain/checks';
import { parseEventStatusChange } from '../domain/event-details';
import {
  BlogPostArchived as ArchivedEvent,
  BlogPostPaused as PausedEvent,
  BlogPostPublished as PublishedEvent,
  BlogPostResumed as ResumedEvent,
} from '../domain/events';
import { closedObject, plainText } from '../domain/fields';
import type { Problems } from '../domain/fields';
import { refusalFor, statusAfter } from '../domain/lifecycle';
import { parseSchedule } from '../domain/schedule';
import { parsePostSlug } from '../domain/slug';
import type { BlogDependencies } from './blog-dependencies';
import { accessToPost, requireSellerAccess } from './edit-flow';
import type { Author } from './edit-flow';
import { invalid } from './failures';
import type { BlogFailure } from './failures';
import {
  adminOf,
  detailOf,
  emit,
  factsOf,
  fieldsOf,
  loadPost,
  lockPost,
  policyOf,
  sellerOf,
} from './post-support';
import type { LoadedPost, PostDetailView } from './post-support';
import type { DueKey, PostRecord, Stamp, VersionId, VersionRecord } from './ports/blog.repository';

// What happens to a post once it is approved: it goes live (now, or at a scheduled instant by the
// worker), is paused and resumed, archived, renamed (an old address redirects), featured, and an
// event's status changes at once. Each call locks the post first and is audited in its unit.
// A seller's post goes live only while its seller's blog switch is on, which is read outside the
// unit, before it.

type Failure = BlogFailure;

/** Reads the post (no lock) to learn its owner before the switch is asked. */
async function ownerOf(
  deps: BlogDependencies,
  market: MarketContext,
  raw: unknown,
): Promise<Result<LoadedPost, Failure>> {
  return deps.unitOfWork.run<LoadedPost, Failure>(market, async () => loadPost(deps, market, raw), {
    readOnly: true,
  });
}

/** Refuses a seller's post while the seller's switch is off. */
async function sellerSwitch(
  deps: BlogDependencies,
  context: CallContext,
  post: PostRecord,
): Promise<Failure | null> {
  return post.sellerId === null ? null : requireSellerAccess(deps, context, post.sellerId);
}

function versionNoOf(body: unknown, extra: readonly string[] = []) {
  const problems: Problems = [];
  if (!closedObject(problems, '', body, ['versionNo', ...extra])) {
    return { versionNo: null, problems, record: null };
  }
  const value = body.versionNo;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    problems.push({ path: 'versionNo', code: value === undefined ? 'required' : 'format' });
    return { versionNo: null, problems, record: body };
  }
  return { versionNo: value, problems, record: body };
}

/**
 * Makes the approved open version the live one: the live version it replaces is retired first (a
 * post has one live version), the post is published, and any schedule, pause and note are cleared.
 */
async function makeLive(
  deps: BlogDependencies,
  market: MarketContext,
  post: PostRecord,
  open: VersionRecord,
  stamp: Stamp,
  publishedBy: Id<'Account'>,
): Promise<void> {
  if (post.liveVersionId !== null) {
    await deps.posts.updateVersion(
      market,
      post.id,
      post.liveVersionId,
      { state: 'retired' },
      stamp.at,
    );
  }
  await deps.posts.updateVersion(
    market,
    post.id,
    open.id,
    { state: 'live', publishedAt: stamp.at, publishedBy },
    stamp.at,
  );
  await deps.posts.updatePost(
    market,
    post.id,
    {
      status: 'published',
      liveVersionId: open.id,
      draftVersionId: null,
      scheduledAt: null,
      publishedAt: post.publishedAt ?? stamp.at,
      unpublishedAt: null,
      pausedReason: null,
    },
    stamp,
  );
}

const reload = async (
  deps: BlogDependencies,
  market: MarketContext,
  post: PostRecord,
  forAdmin = true,
): Promise<Result<PostDetailView, Failure>> => {
  const loaded = await loadPost(deps, market, post.id);
  if (!loaded.ok) return err(loaded.error);
  return ok(await detailOf(deps, market, loaded.value, forAdmin));
};

/** An admin makes the approved version live now. */
export async function publishPost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const reviewed = versionNoOf(input?.body);
  if (reviewed.versionNo === null) return err(fieldsOf(reviewed.problems));
  const owner = await ownerOf(deps, market, input?.post);
  if (!owner.ok) return err(owner.error);
  const refusedSwitch = await sellerSwitch(deps, context, owner.value.post);
  if (refusedSwitch !== null) return err(refusedSwitch);
  const at = deps.clock.now();
  const stamp: Stamp = { at, by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const refused = refusalFor('publish', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    if (open!.versionNo !== reviewed.versionNo) return err({ code: 'conflict.stale' });
    await makeLive(deps, market, post, open!, stamp, admin.accountId);
    await deps.audit.record(
      context,
      BlogPostPublished.entry(post.id, { after: { versionNo: open!.versionNo, scheduled: false } }),
    );
    await emit(deps, context, PublishedEvent, post, open!.id);
    return reload(deps, market, post);
  });
}

/** An admin sets the instant the approved version goes live; the worker publishes it then. */
export async function schedulePost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const reviewed = versionNoOf(input?.body, ['scheduledAt']);
  const problems: Problems = [...reviewed.problems];
  const at = deps.clock.now();
  const when =
    reviewed.record === null
      ? null
      : parseSchedule(problems, 'scheduledAt', reviewed.record.scheduledAt, at);
  if (reviewed.versionNo === null || when === null || problems.length > 0) {
    return err(fieldsOf(problems));
  }
  const owner = await ownerOf(deps, market, input?.post);
  if (!owner.ok) return err(owner.error);
  const refusedSwitch = await sellerSwitch(deps, context, owner.value.post);
  if (refusedSwitch !== null) return err(refusedSwitch);
  const stamp: Stamp = { at, by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const facts = factsOf(post, open);
    const refused = refusalFor('schedule', facts);
    if (refused !== null) return err({ code: refused });
    if (open!.versionNo !== reviewed.versionNo) return err({ code: 'conflict.stale' });
    await deps.posts.updatePost(
      market,
      post.id,
      { scheduledAt: when, scheduledBy: admin.accountId, status: statusAfter('schedule', facts) },
      stamp,
    );
    await deps.audit.record(
      context,
      BlogPostScheduled.entry(post.id, {
        before: { scheduledAt: post.scheduledAt },
        after: { versionNo: open!.versionNo, scheduledAt: when, cause: null },
      }),
    );
    return reload(deps, market, post);
  });
}

/** An admin removes the schedule; the version stays approved. */
export async function unschedulePost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const facts = factsOf(post, open);
    const refused = refusalFor('unschedule', facts);
    if (refused !== null) return err({ code: refused });
    await deps.posts.updatePost(
      market,
      post.id,
      { scheduledAt: null, status: statusAfter('unschedule', facts) },
      stamp,
    );
    await deps.audit.record(
      context,
      BlogPostScheduled.entry(post.id, {
        before: { scheduledAt: post.scheduledAt },
        after: { versionNo: open?.versionNo ?? 0, scheduledAt: null, cause: null },
      }),
    );
    return reload(deps, market, post);
  });
}

/** Takes a published post off the site at once, no approval; the reason is kept for the editors. */
export async function pausePost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const problems: Problems = [];
  if (!closedObject(problems, '', input?.body, ['reason'])) return err(fieldsOf(problems));
  const reason = plainText(problems, 'reason', input.body.reason, { max: 300 });
  if (reason === null) return err(fieldsOf(problems));
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const refused = refusalFor('pause', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    await deps.posts.updatePost(
      market,
      post.id,
      { status: 'unpublished', unpublishedAt: stamp.at, pausedReason: reason, featured: false },
      stamp,
    );
    await deps.audit.record(context, BlogPostPaused.entry(post.id, { after: { cause: 'editor' } }));
    await emit(deps, context, PausedEvent, post, post.liveVersionId!);
    return reload(deps, market, post);
  });
}

/** Puts a paused post back on the site: the live version it had comes back, no new review. */
export async function resumePost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const owner = await ownerOf(deps, market, input?.post);
  if (!owner.ok) return err(owner.error);
  const refusedSwitch = await sellerSwitch(deps, context, owner.value.post);
  if (refusedSwitch !== null) return err(refusedSwitch);
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const refused = refusalFor('resume', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    await deps.posts.updatePost(
      market,
      post.id,
      { status: 'published', unpublishedAt: null, pausedReason: null },
      stamp,
    );
    const live = await deps.posts.findVersion(market, post.id, post.liveVersionId!);
    await deps.audit.record(
      context,
      BlogPostResumed.entry(post.id, { after: { versionNo: live?.versionNo ?? 0 } }),
    );
    await emit(deps, context, ResumedEvent, post, post.liveVersionId!);
    return reload(deps, market, post);
  });
}

/**
 * Archives a post: it is never served again and takes no further change. A post that was on the
 * site keeps its address, which answers 410 from now on. Versions in work are retired.
 */
export async function archivePost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
  as: Author,
): Promise<Result<PostDetailView, Failure>> {
  const { market } = context;
  const caller =
    as === 'admin'
      ? adminOf(context) === null
        ? null
        : { accountId: adminOf(context)!.accountId, sellerId: null }
      : sellerOf(context);
  if (caller === null) return err({ code: 'access.denied' });
  if (caller.sellerId !== null) {
    const refused = await requireSellerAccess(deps, context, caller.sellerId);
    if (refused !== null) return err(refused);
  }
  const stamp: Stamp = { at: deps.clock.now(), by: caller.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const access = accessToPost(post, caller, as);
    if (access !== null) return err(access);
    const refused = refusalFor('archive', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    if (open !== null) {
      await deps.posts.updateVersion(market, post.id, open.id, { state: 'retired' }, stamp.at);
    }
    const wasLive = post.publishedAt !== null;
    await deps.posts.updatePost(
      market,
      post.id,
      {
        status: 'archived',
        draftVersionId: null,
        scheduledAt: null,
        featured: false,
        ...(wasLive
          ? {
              unpublishedAt: post.unpublishedAt ?? stamp.at,
              pausedReason: post.pausedReason ?? 'Archived',
            }
          : {}),
      },
      stamp,
    );
    await deps.audit.record(context, BlogPostArchived.entry(post.id, { after: { wasLive } }));
    await emit(deps, context, ArchivedEvent, post, (post.liveVersionId ?? open?.id) as VersionId);
    return reload(deps, market, post, as === 'admin');
  });
}

/**
 * Changes the slug of a post that has been on the site. The old address is kept as a redirect, so
 * links already out there still land on the post; taking an old slug back removes its redirect.
 */
export async function renameSlug(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const problems: Problems = [];
  if (!closedObject(problems, '', input?.body, ['slug'])) return err(fieldsOf(problems));
  const slug = parsePostSlug(problems, 'slug', input.body.slug);
  if (slug === null) return err(fieldsOf(problems));
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const refused = refusalFor('rename-slug', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    if (slug === post.slug) return reload(deps, market, post);
    if (!(await deps.posts.isSlugFree(market, slug, post.id)))
      return err({ code: 'blog.slug-taken' });
    const own = await deps.posts.findRedirect(market, slug);
    if (own !== null) await deps.posts.deleteRedirect(market, slug);
    await deps.posts.updatePost(market, post.id, { slug }, stamp);
    await deps.posts.insertRedirect(
      market,
      { id: deps.ids.next<'BlogRedirect'>(), fromSlug: post.slug, postId: post.id },
      stamp.at,
    );
    await deps.audit.record(
      context,
      BlogPostSlugChanged.entry(post.id, { after: { redirected: true } }),
    );
    return reload(deps, market, post);
  });
}

/** Makes a published post the Market's featured one (the previous one stops being it), or not. */
export async function setFeatured(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, Failure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const problems: Problems = [];
  if (!closedObject(problems, '', input?.body, ['featured'])) return err(fieldsOf(problems));
  const featured = input.body.featured;
  if (typeof featured !== 'boolean') {
    return err(invalid('featured', featured === undefined ? 'required' : 'type'));
  }
  const stamp: Stamp = { at: deps.clock.now(), by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const refused = refusalFor('feature', factsOf(post, open));
    if (refused !== null) return err({ code: refused });
    if (featured) {
      await deps.posts.clearFeatured(market, stamp);
      // Two posts featured at once: the unique key lets one through; the other is told to retry.
      if (!(await deps.posts.markFeatured(market, post.id, stamp))) {
        return err({ code: 'conflict.stale' });
      }
    } else {
      await deps.posts.updatePost(market, post.id, { featured }, stamp);
    }
    await deps.audit.record(
      context,
      BlogPostFeatured.entry(post.id, { before: { featured: post.featured }, after: { featured } }),
    );
    return reload(deps, market, post);
  });
}

/**
 * Changes the status of an event (cancelled, postponed, rescheduled, back to scheduled) on the live
 * version and the version in work at once, with no review. Audited. A seller changes its own.
 */
export async function setEventStatus(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
  as: Author,
): Promise<Result<PostDetailView, Failure>> {
  const { market } = context;
  const caller =
    as === 'admin'
      ? adminOf(context) === null
        ? null
        : { accountId: adminOf(context)!.accountId, sellerId: null }
      : sellerOf(context);
  if (caller === null) return err({ code: 'access.denied' });
  const parsed = parseEventStatusChange(input?.body);
  if (parsed.change === null) return err(fieldsOf(parsed.problems));
  const change = parsed.change;
  if (caller.sellerId !== null) {
    const refused = await requireSellerAccess(deps, context, caller.sellerId);
    if (refused !== null) return err(refused);
  }
  if (change.message !== null) {
    // The message goes live at once with no review: it gets the checks a reviewer would rely on.
    const policy = policyOf(deps, market);
    if (policy === null) return err({ code: 'blog.unavailable' });
    const asked = await deps.links.claimsFlagged(context, [
      { locale: policy.defaultLocale, text: change.message },
    ]);
    const flagged = asked.ok && asked.value.length === 1 ? asked.value[0]! : null;
    const findings = statusMessageFindings(change.message, flagged);
    if (findings.length > 0) return err({ code: 'blog.checks-failed', findings });
  }
  const stamp: Stamp = { at: deps.clock.now(), by: caller.accountId };
  return deps.unitOfWork.run<PostDetailView, Failure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const access = as === 'admin' ? null : accessToPost(post, caller, as);
    if (access !== null) return err(access);
    if (post.status === 'archived') return err({ code: 'blog.post-archived' });
    if (post.kind !== 'event') return err({ code: 'blog.wrong-state' });
    const live =
      post.liveVersionId === null
        ? null
        : await deps.posts.findVersion(market, post.id, post.liveVersionId);
    const versions = [live, open].filter(
      (v): v is VersionRecord => v !== null && v.content.event !== null,
    );
    if (versions.length === 0) return err({ code: 'blog.wrong-state' });
    const before = versions[0]!.content.event!.eventStatus;
    await deps.posts.setEventStatus(
      market,
      versions.map((v) => v.id),
      change.status,
      change.message,
    );
    await deps.posts.updatePost(market, post.id, {}, stamp);
    await deps.audit.record(
      context,
      BlogPostEventStatusChanged.entry(post.id, {
        before: { eventStatus: before },
        after: { eventStatus: change.status, messageSet: change.message !== null },
      }),
    );
    return reload(deps, market, post, as === 'admin');
  });
}

// ------------------------------------------------------------------------------------------
// The worker

export interface DueRun {
  readonly published: number;
  readonly skipped: number;
}

const DUE_BATCH = 50;
/** The most batches one run reads; the rest waits for the next run (a minute later). */
const DUE_PAGES = 20;

/**
 * Publishes the approved versions whose scheduled instant has come (job `blog.publish-due`, every
 * minute, per Market). One unit per post, so one post that cannot go live does not hold back the
 * others. The queue is read in pages keyed on (`scheduledAt`, `id`), so posts that are skipped (a
 * seller whose switch is off or unreadable, a post that cannot be published) never block the ones
 * after them. Idempotent: a post is published only while it is still scheduled, due and approved,
 * and publishing clears the schedule, so a second run (or a concurrent one, serialised on the post
 * row) finds nothing to do. The seller's switch is read outside the units. The account recorded as
 * the publisher is the admin who set the schedule (`scheduledBy`).
 */
export async function publishDue(
  deps: BlogDependencies,
  context: CallContext,
): Promise<Result<DueRun, Failure>> {
  const { market } = context;
  const now = deps.clock.now();
  const switches = new Map<string, boolean | null>();
  let published = 0;
  let skipped = 0;
  let after: DueKey | null = null;
  for (let page = 0; page < DUE_PAGES; page += 1) {
    const cursor: DueKey | null = after;
    const due: Result<readonly PostRecord[], Failure> = await deps.unitOfWork.run<
      readonly PostRecord[],
      Failure
    >(market, async () => ok(await deps.posts.duePosts(market, now, DUE_BATCH, cursor)), {
      readOnly: true,
    });
    if (!due.ok) return err(due.error);
    if (due.value.length === 0) break;
    const last: PostRecord = due.value[due.value.length - 1]!;
    after = { scheduledAt: last.scheduledAt!, id: last.id };

    for (const post of due.value) {
      if (post.sellerId === null || switches.has(post.sellerId)) continue;
      const enabled = await deps.links.sellerBlogEnabled(context, post.sellerId);
      switches.set(post.sellerId, enabled.ok ? enabled.value : null);
    }

    for (const candidate of due.value) {
      if (candidate.sellerId !== null && switches.get(candidate.sellerId) !== true) {
        skipped += 1;
        continue;
      }
      const outcome = await deps.unitOfWork.run<boolean, Failure>(market, async () => {
        const locked = await lockPost(deps, market, candidate.id);
        if (!locked.ok) return ok(false);
        const { post, open } = locked.value;
        const facts = factsOf(post, open);
        if (
          post.scheduledAt === null ||
          Temporal.Instant.compare(post.scheduledAt, now) > 0 ||
          refusalFor('publish', facts) !== null
        ) {
          return ok(false);
        }
        const by = post.scheduledBy ?? post.updatedBy;
        const stamp: Stamp = { at: now, by };
        await makeLive(deps, market, post, open!, stamp, by);
        await deps.audit.record(
          context,
          BlogPostPublished.entry(post.id, {
            after: { versionNo: open!.versionNo, scheduled: true },
          }),
        );
        await emit(deps, context, PublishedEvent, post, open!.id);
        return ok(true);
      });
      if (!outcome.ok) return err(outcome.error);
      if (outcome.value) published += 1;
      else skipped += 1;
    }
    if (due.value.length < DUE_BATCH) break;
  }
  return ok({ published, skipped });
}

/** One delivery of `sellers.blog-access-changed.v1`. */
export interface SellerAccessDelivery {
  readonly delivery: EventDelivery;
  readonly sellerId: string;
  readonly enabled: boolean;
  readonly unpublishLive: boolean;
}

/** What the seller-switch handler did. */
export interface SellerPostsChanged {
  readonly paused: number;
  readonly unscheduled: number;
}

const PAUSE_REASON = 'Blog access of the seller was turned off';

/**
 * When an admin turned a seller's blog access off and asked for the live posts to come down, the
 * seller's published posts are paused (not deleted; an admin may resume them after the switch is
 * on again). The handler acts only while the switch is still off, so a late delivery of an old
 * event never pauses what a later "on" allowed. Delivered once per event (the inbox), in one unit.
 */
export async function pauseSellerPosts(
  deps: BlogDependencies,
  context: CallContext,
  input: SellerAccessDelivery,
): Promise<Result<SellerPostsChanged, Failure>> {
  const { market } = context;
  const sellerId = input.sellerId as Id<'Seller'>;
  // Both acts happen only while the switch is still off when the event is handled.
  let stillOff = false;
  if (!input.enabled) {
    const current = await deps.links.sellerBlogEnabled(context, sellerId);
    if (!current.ok) return err({ code: 'blog.unavailable' });
    stillOff = !current.value;
  }
  const act = stillOff && input.unpublishLive;
  const handled = await deps.unitOfWork.runOnce<SellerPostsChanged, Failure>(
    market,
    input.delivery,
    async () => {
      // A scheduled post of a seller without blog access could never be published; leaving it
      // scheduled would only keep it at the head of the due queue. The schedule is removed (the
      // version stays approved) whether or not the live posts come down.
      let unscheduled = 0;
      if (stillOff) {
        for (let round = 0; round < 20; round += 1) {
          const batch = await deps.posts.scheduledPostsOfSeller(market, sellerId, 100);
          if (batch.length === 0) break;
          for (const candidate of batch) {
            const locked = await lockPost(deps, market, candidate.id);
            if (!locked.ok || locked.value.post.scheduledAt === null) continue;
            const { post, open } = locked.value;
            const at = deps.clock.now();
            const status = statusAfter('unschedule', factsOf(post, open));
            await deps.posts.updatePost(
              market,
              post.id,
              { scheduledAt: null, status },
              { at, by: post.updatedBy },
            );
            await deps.audit.record(
              context,
              BlogPostScheduled.entry(post.id, {
                before: { scheduledAt: post.scheduledAt },
                after: {
                  versionNo: open?.versionNo ?? 0,
                  scheduledAt: null,
                  cause: 'seller-switch-off',
                },
              }),
            );
            unscheduled += 1;
          }
        }
      }
      if (!act) return ok({ paused: 0, unscheduled });
      let paused = 0;
      for (let round = 0; round < 20; round += 1) {
        const batch = await deps.posts.publishedPostsOfSeller(market, sellerId, 100);
        if (batch.length === 0) break;
        for (const candidate of batch) {
          const locked = await deps.posts.lockPost(market, candidate.id);
          if (locked === null || locked.status !== 'published') continue;
          const at = deps.clock.now();
          await deps.posts.updatePost(
            market,
            locked.id,
            {
              status: 'unpublished',
              unpublishedAt: at,
              pausedReason: PAUSE_REASON,
              featured: false,
            },
            { at, by: locked.updatedBy },
          );
          await deps.audit.record(
            context,
            BlogPostPaused.entry(locked.id, { after: { cause: 'seller-switch-off' } }),
          );
          await emit(deps, context, PausedEvent, locked, locked.liveVersionId!);
          paused += 1;
        }
      }
      return ok({ paused, unscheduled });
    },
  );
  if (!handled.ok) return err(handled.error);
  return ok(handled.value.handled ? handled.value.value : { paused: 0, unscheduled: 0 });
}
