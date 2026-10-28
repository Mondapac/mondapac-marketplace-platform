import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { BlogPostApproved, BlogPostChangesRequested, BlogPostSubmitted } from '../domain/audit';
import { blocking, readableTexts, runChecks } from '../domain/checks';
import type { Finding, ProductFact } from '../domain/checks';
import { linksOf } from '../domain/content';
import type { PostContent } from '../domain/content';
import {
  BlogPostApproved as ApprovedEvent,
  BlogPostChangesRequested as ChangesRequestedEvent,
  BlogPostSubmitted as SubmittedEvent,
} from '../domain/events';
import { closedObject, plainText } from '../domain/fields';
import type { Problems } from '../domain/fields';
import { refusalFor, statusAfter } from '../domain/lifecycle';
import { hasQuotaLeft, quotaPeriod } from '../domain/quota';
import { approvalDecision, writersOf } from '../domain/separation';
import type { BlogDependencies } from './blog-dependencies';
import { requireSellerAccess, accessToPost } from './edit-flow';
import type { Author } from './edit-flow';
import type { BlogFailure } from './failures';
import { BLOG_SELF_APPROVE_STEP_UP } from '../contracts/step-up';
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
import type { BlogMarketPolicy } from './ports/blog-policy';
import type { PostRecord, Stamp, VersionRecord } from './ports/blog.repository';

// The review side of the blog: an author sends a draft for review; a reviewer asks for changes or
// approves it. The automatic checks run at the submit and again at the approval, outside any unit
// (they ask other modules). The write that follows locks the post, reads it again and refuses when
// the version changed since the checks (`conflict.stale`). Nothing here makes a version live: that
// is `publish`, a separate key.

const CHECKS_CHUNK = 100;

/** Runs the automatic checks on a version's content (see domain/checks.ts). */
export async function findingsOf(
  deps: BlogDependencies,
  context: CallContext,
  post: PostRecord,
  content: PostContent,
  policy: BlogMarketPolicy,
): Promise<readonly Finding[]> {
  const productIds = linksOf(content)
    .filter((link) => link.type === 'product')
    .map((link) => link.id);
  let products: ReadonlyMap<string, ProductFact> | null = new Map();
  if (productIds.length > 0) {
    const asked = await deps.links.products(context, productIds, post.sellerId);
    products = asked.ok ? asked.value : null;
  }

  const texts = readableTexts(content);
  let claims: { readonly hitPaths: ReadonlySet<string> } | null = { hitPaths: new Set() };
  const hitPaths = new Set<string>();
  for (let from = 0; from < texts.length && claims !== null; from += CHECKS_CHUNK) {
    const chunk = texts.slice(from, from + CHECKS_CHUNK);
    const asked = await deps.links.claimsFlagged(
      context,
      chunk.map(({ text }) => ({ locale: policy.defaultLocale, text })),
    );
    if (!asked.ok || asked.value.length !== chunk.length) {
      claims = null;
      break;
    }
    for (const [index, flagged] of asked.value.entries()) {
      if (flagged) hitPaths.add(chunk[index]!.path);
    }
  }
  if (claims !== null) claims = { hitPaths };

  return runChecks({
    kind: post.kind,
    ownerType: post.ownerType,
    sellerId: post.sellerId,
    content,
    now: deps.clock.now(),
    currencyCode: policy.currencyCode,
    healthTerms: policy.healthTerms,
    products,
    claims,
  });
}

/** Who may reach the post: an admin the platform posts and, to review, all; a seller its own. */
function callerOf(context: CallContext, as: Author) {
  if (as === 'admin') {
    const admin = adminOf(context);
    return admin === null ? null : { accountId: admin.accountId, sellerId: null };
  }
  const seller = sellerOf(context);
  return seller === null ? null : { accountId: seller.accountId, sellerId: seller.sellerId };
}

/** The version a call reviewed must be the one still open. */
function sameVersion(before: VersionRecord, after: VersionRecord | null): boolean {
  return (
    after !== null &&
    after.id === before.id &&
    after.updatedAt.epochNanoseconds === before.updatedAt.epochNanoseconds &&
    after.state === before.state
  );
}

/** An author sends the draft for review, after the automatic checks pass. */
export async function submitPost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
  as: Author,
): Promise<Result<PostDetailView, BlogFailure>> {
  const caller = callerOf(context, as);
  if (caller === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  if (caller.sellerId !== null) {
    const refused = await requireSellerAccess(deps, context, caller.sellerId);
    if (refused !== null) return err(refused);
  }

  // 1. Read: the post, the lifecycle and (a seller's first submit) the quota left.
  const first = await deps.unitOfWork.run<LoadedPost, BlogFailure>(
    market,
    async () => {
      const loaded = await loadPost(deps, market, input?.post);
      if (!loaded.ok) return err(loaded.error);
      const { post, open } = loaded.value;
      const access = accessToPost(post, caller, as);
      if (access !== null) return err(access);
      const refused = refusalFor('submit', factsOf(post, open));
      if (refused !== null) return err({ code: refused });
      if (post.ownerType === 'seller' && post.quotaPeriod === null) {
        const period = quotaPeriod(deps.clock.now(), policy.timeZone);
        const used = await deps.posts.quotaUsed(market, post.sellerId!, period);
        if (!hasQuotaLeft(used, policy.sellerPostsPerMonth))
          return err({ code: 'blog.quota-used' });
      }
      return ok(loaded.value);
    },
    { readOnly: true },
  );
  if (!first.ok) return err(first.error);

  // 2. The automatic checks, outside any unit.
  const checked = first.value;
  const findings = await findingsOf(deps, context, checked.post, checked.open!.content, policy);
  const stoppers = blocking(findings);
  if (stoppers.length > 0) return err({ code: 'blog.checks-failed', findings: stoppers });

  // 3. Write: lock, read again, and move the version into review.
  const at = deps.clock.now();
  const stamp: Stamp = { at, by: caller.accountId };
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    if (!sameVersion(checked.open!, open)) return err({ code: 'conflict.stale' });
    const facts = factsOf(post, open);
    const refused = refusalFor('submit', facts);
    if (refused !== null) return err({ code: refused });
    let quotaUsed = false;
    let period: string | null = post.quotaPeriod;
    if (post.ownerType === 'seller' && post.quotaPeriod === null) {
      period = quotaPeriod(at, policy.timeZone);
      const consumed = await deps.posts.consumeQuota(
        market,
        post.sellerId!,
        period,
        policy.sellerPostsPerMonth,
        at,
      );
      if (!consumed) return err({ code: 'blog.quota-used' });
      quotaUsed = true;
    }
    await deps.posts.updateVersion(
      market,
      post.id,
      open!.id,
      { state: 'in_review', submittedAt: at, submittedBy: caller.accountId },
      at,
    );
    await deps.posts.updatePost(
      market,
      post.id,
      { status: statusAfter('submit', facts), ...(quotaUsed ? { quotaPeriod: period } : {}) },
      stamp,
    );
    await deps.audit.record(
      context,
      BlogPostSubmitted.entry(post.id, { after: { versionNo: open!.versionNo, quotaUsed } }),
    );
    await emit(deps, context, SubmittedEvent, post, open!.id);
    const reloaded = await loadPost(deps, market, post.id);
    if (!reloaded.ok) return err(reloaded.error);
    return ok(await detailOf(deps, market, reloaded.value, as === 'admin'));
  });
}

/** The version a reviewer's call names (`versionNo` of the body); a body with more is refused. */
function reviewedVersion(
  body: unknown,
  extra: readonly string[] = [],
): {
  readonly versionNo: number | null;
  readonly problems: Problems;
  readonly record: Record<string, unknown> | null;
} {
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

/** What a reviewer sees before deciding: the findings, warnings and notices included. */
export interface ChecksView {
  readonly versionNo: number;
  readonly findings: readonly Finding[];
}

/** Runs the automatic checks on the version in work and answers every finding. */
export async function runPostChecks(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown },
): Promise<Result<ChecksView, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const read = await deps.unitOfWork.run<LoadedPost, BlogFailure>(
    market,
    async () => loadPost(deps, market, input?.post),
    { readOnly: true },
  );
  if (!read.ok) return err(read.error);
  const { post, open } = read.value;
  if (open === null) return err({ code: 'blog.wrong-state' });
  return ok({
    versionNo: open.versionNo,
    findings: await findingsOf(deps, context, post, open.content, policy),
  });
}

/**
 * A reviewer approves the version in review that they read (`versionNo`). The checks run again.
 * The approver is not the version's writer nor its submitter (a reviewer who edited it counts as
 * its writer); a Market that allows a single admin to approve their own work asks for a fresh
 * step-up, spent in the same unit, and the approval is recorded as a self-approval. A seller's post
 * is approved only while its seller's blog switch is on.
 */
export async function approvePost(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'blog.unavailable' });
  const reviewed = reviewedVersion(input?.body);
  if (reviewed.versionNo === null) return err(fieldsOf(reviewed.problems));

  const first = await deps.unitOfWork.run<
    LoadedPost & { readonly writers: readonly string[] },
    BlogFailure
  >(
    market,
    async () => {
      const loaded = await loadPost(deps, market, input?.post);
      if (!loaded.ok) return err(loaded.error);
      const { post, open } = loaded.value;
      const refused = refusalFor('approve', factsOf(post, open));
      if (refused !== null) return err({ code: refused });
      if (open!.versionNo !== reviewed.versionNo) return err({ code: 'conflict.stale' });
      const versions = await deps.posts.versionSummaries(market, post.id);
      return ok({ ...loaded.value, writers: writersOf(versions, open!.versionNo) });
    },
    { readOnly: true },
  );
  if (!first.ok) return err(first.error);
  const checked = first.value;
  const version = checked.open!;

  // The writers are read with the version; the write below refuses a version changed since.
  const decision = approvalDecision(
    { approver: admin.accountId, writers: checked.writers, submittedBy: version.submittedBy },
    policy.selfApprovalWithStepUp,
  );
  if (decision.kind === 'denied') return err({ code: 'blog.self-approval-refused' });
  if (checked.post.sellerId !== null) {
    const refused = await requireSellerAccess(deps, context, checked.post.sellerId);
    if (refused !== null) return err(refused);
  }
  const findings = await findingsOf(deps, context, checked.post, version.content, policy);
  const stoppers = blocking(findings);
  if (stoppers.length > 0) return err({ code: 'blog.checks-failed', findings: stoppers });

  const at = deps.clock.now();
  const stamp: Stamp = { at, by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    if (!sameVersion(version, open)) return err({ code: 'conflict.stale' });
    const facts = factsOf(post, open);
    const refused = refusalFor('approve', facts);
    if (refused !== null) return err({ code: refused });
    let verifiedAt = null;
    if (decision.kind === 'step-up') {
      const spent = await deps.stepUp.consume(context, BLOG_SELF_APPROVE_STEP_UP);
      if (!spent.ok) {
        const refusal = spent.error;
        if (
          refusal.code === 'second-factor.required' ||
          refusal.code === 'second-factor.enrolment-required'
        ) {
          return err({ code: refusal.code, actionKey: refusal.actionKey });
        }
        return err({
          code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied',
        });
      }
      verifiedAt = spent.value.verifiedAt;
    }
    await deps.posts.updateVersion(
      market,
      post.id,
      open!.id,
      {
        state: 'approved',
        decision: 'approved',
        decidedAt: at,
        decidedBy: admin.accountId,
        decisionNote: null,
        selfApproved: decision.selfApproved,
      },
      at,
    );
    await deps.posts.updatePost(market, post.id, { status: statusAfter('approve', facts) }, stamp);
    await deps.audit.record(
      context,
      BlogPostApproved.entry(post.id, {
        after: {
          versionNo: open!.versionNo,
          selfApproved: decision.selfApproved,
          stepUpVerifiedAt: verifiedAt,
        },
      }),
    );
    await emit(deps, context, ApprovedEvent, post, open!.id);
    const reloaded = await loadPost(deps, market, post.id);
    if (!reloaded.ok) return err(reloaded.error);
    return ok(await detailOf(deps, market, reloaded.value, true));
  });
}

/** A reviewer sends the version back with a note the author reads. */
export async function requestChanges(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly post: unknown; readonly body: unknown },
): Promise<Result<PostDetailView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const { market } = context;
  const reviewed = reviewedVersion(input?.body, ['note']);
  const problems: Problems = [...reviewed.problems];
  const note =
    reviewed.record === null
      ? null
      : plainText(problems, 'note', reviewed.record.note, { max: 1000, multiline: true });
  if (reviewed.versionNo === null || note === null || problems.length > 0) {
    return err(fieldsOf(problems));
  }
  const at = deps.clock.now();
  const stamp: Stamp = { at, by: admin.accountId };
  return deps.unitOfWork.run<PostDetailView, BlogFailure>(market, async () => {
    const locked = await lockPost(deps, market, input?.post);
    if (!locked.ok) return err(locked.error);
    const { post, open } = locked.value;
    const facts = factsOf(post, open);
    const refused = refusalFor('request-changes', facts);
    if (refused !== null) return err({ code: refused });
    if (open!.versionNo !== reviewed.versionNo) return err({ code: 'conflict.stale' });
    await deps.posts.updateVersion(
      market,
      post.id,
      open!.id,
      {
        state: 'returned',
        decision: 'changes_requested',
        decidedAt: at,
        decidedBy: admin.accountId,
        decisionNote: note,
      },
      at,
    );
    await deps.posts.updatePost(
      market,
      post.id,
      { status: statusAfter('request-changes', facts) },
      stamp,
    );
    await deps.audit.record(
      context,
      BlogPostChangesRequested.entry(post.id, { after: { versionNo: open!.versionNo } }),
    );
    await emit(deps, context, ChangesRequestedEvent, post, open!.id);
    const reloaded = await loadPost(deps, market, post.id);
    if (!reloaded.ok) return err(reloaded.error);
    return ok(await detailOf(deps, market, reloaded.value, true));
  });
}
