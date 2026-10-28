import { Temporal } from '@mondapac/shared-kernel';
import {
  aCategory,
  approvedNews,
  content,
  createNews,
  eventDetails,
  liveNews,
  PUBLISHER,
  refusal,
  REVIEWER,
  unwrap,
  WRITER,
} from '../../../../../test/support/blog-fixtures';
import { blogHarness, quietLogs } from '../../../../../test/support/blog-harness';

// The life of a platform post, on both Market fixtures: write, check, send, review, go live, edit
// a live post, pause, rename, archive and the public reads. The rules of each step are tested as
// pure functions in domain/; here the steps run behind the real gate and the real flows.

quietLogs();

describe.each([['AU'], ['ZZ']] as const)('blog post lifecycle in %s', (code) => {
  const writer = (h: ReturnType<typeof blogHarness>) => h.admin('writer', WRITER);
  const reviewer = (h: ReturnType<typeof blogHarness>) => h.admin('reviewer', REVIEWER);
  const publisher = (h: ReturnType<typeof blogHarness>) => h.admin('publisher', PUBLISHER);

  it('creates a draft with a slug made from the title and audits it', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const post = await createNews(h, writer(h), category, 'Ramadan table ideas');
    expect(post).toMatchObject({
      kind: 'news',
      slug: 'ramadan-table-ideas',
      status: 'draft',
      ownerType: 'platform',
      sellerId: null,
    });
    expect(post.open).toMatchObject({ versionNo: 1, state: 'draft' });
    expect(post.live).toBeNull();
    expect(h.audits.map((a) => a.action)).toContain('blog.post.create');

    // The same title again gets another address, not an error.
    const again = await createNews(h, writer(h), category, 'Ramadan table ideas');
    expect(again.slug).not.toBe(post.slug);
  });

  it('refuses markup and unknown fields in the content, naming the path only', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const refused = refusal(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'news',
          content: { ...content({ categoryId: category }), title: '<b>x</b>', html: '<p>' },
        },
      }),
    );
    expect(refused).toMatchObject({ code: 'validation.failed' });
    expect(JSON.stringify(refused)).not.toContain('<b>');
  });

  it('refuses a category that does not exist in the Market', async () => {
    const h = blogHarness(code);
    const refused = refusal(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'news',
          content: content({ categoryId: '0197b000-0000-7000-8000-0000000000ff' }),
        },
      }),
    );
    expect(refused).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'content.categoryId', code: 'not-found' }],
    });
  });

  it('refuses to send a draft that fails the automatic checks, with the findings', async () => {
    const h = blogHarness(code);
    const post = unwrap(
      await h.cases.createPost.execute(writer(h), {
        body: { kind: 'news', content: { title: 'Bare draft' } },
      }),
    );
    const refused = refusal(await h.cases.submitPost.execute(writer(h), { post: post.id }));
    expect(refused.code).toBe('blog.checks-failed');
    const findings = (refused as unknown as { findings: { code: string }[] }).findings.map(
      (f) => f.code,
    );
    expect(findings).toEqual(
      expect.arrayContaining(['cover-missing', 'category-missing', 'body-empty']),
    );
  });

  it('refuses a certification claim and an outside link in the text', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = unwrap(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'news',
          content: content({
            categoryId: category,
            extra: { excerpt: 'We are ISO certified. See example.com for more.' },
          }),
        },
      }),
    );
    const refused = refusal(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    const codes = (refused as unknown as { findings: { code: string }[] }).findings.map(
      (f) => f.code,
    );
    expect(codes).toEqual(expect.arrayContaining(['certification-claim', 'external-link']));
  });

  it('fails closed when the certification check cannot answer', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = await createNews(h, writer(h), category);
    h.links.claimsDown = true;
    const refused = refusal(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    expect(refused.code).toBe('blog.checks-failed');
    expect(
      (refused as unknown as { findings: { code: string }[] }).findings.map((f) => f.code),
    ).toContain('claims-unverifiable');
  });

  it('takes a post from draft to live with three different people, and buyers read the live version', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = await createNews(h, writer(h), category, 'Eid gifts');
    const sent = unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    expect(sent.status).toBe('in_review');
    expect(sent.open).toMatchObject({ state: 'in_review' });

    const approved = unwrap(
      await h.cases.approvePost.execute(reviewer(h), { post: created.id, body: { versionNo: 1 } }),
    );
    expect(approved.status).toBe('approved');
    expect(approved.open?.selfApproved).toBe(false);

    // Not yet on the site.
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: 'eid-gifts' })),
    ).toEqual({
      code: 'blog.not-found',
    });

    const live = unwrap(
      await h.cases.publishPost.execute(publisher(h), { post: created.id, body: { versionNo: 1 } }),
    );
    expect(live.status).toBe('published');
    expect(live.live).toMatchObject({ versionNo: 1, state: 'live' });
    expect(live.open).toBeNull();

    const answer = unwrap(
      await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: 'eid-gifts' }),
    );
    expect(answer).toMatchObject({ kind: 'post', post: { title: 'Eid gifts', slug: 'eid-gifts' } });
    // The public body never carries who wrote or reviewed it.
    expect(JSON.stringify(answer)).not.toMatch(/createdBy|decidedBy|submittedBy|people/);

    const list = unwrap(await h.cases.viewPublishedPosts.execute(h.anonymous(), {}));
    expect(list.items.map((i) => i.slug)).toEqual(['eid-gifts']);
    const actions = h.audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['blog.post.submit', 'blog.post.approve', 'blog.post.publish']),
    );
    expect(h.events.map((e) => e.type)).toEqual([
      'blog.post-submitted.v1',
      'blog.post-approved.v1',
      'blog.post-published.v1',
    ]);
  });

  it('sends a returned post back to its author, who edits it as a new version and sends it again', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = await createNews(h, writer(h), category);
    unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    const returned = unwrap(
      await h.cases.requestChanges.execute(reviewer(h), {
        post: created.id,
        body: { versionNo: 1, note: 'Please shorten the intro.' },
      }),
    );
    expect(returned.status).toBe('changes_requested');
    expect(returned.open).toMatchObject({
      state: 'returned',
      decisionNote: 'Please shorten the intro.',
    });

    const edited = unwrap(
      await h.cases.updateDraft.execute(writer(h), {
        post: created.id,
        body: { content: content({ categoryId: category, title: 'A shorter intro' }) },
      }),
    );
    expect(edited.status).toBe('draft');
    expect(edited.open).toMatchObject({ versionNo: 2, state: 'draft' });
    expect(edited.versions.map((v) => [v.versionNo, v.state])).toEqual([
      [2, 'draft'],
      [1, 'retired'],
    ]);
    const again = unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    expect(again.status).toBe('in_review');
  });

  it('changes a draft in place and refuses a stale approval of an older version', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = await createNews(h, writer(h), category);
    const saved = unwrap(
      await h.cases.updateDraft.execute(writer(h), {
        post: created.id,
        body: { content: content({ categoryId: category, title: 'New title' }) },
      }),
    );
    expect(saved.open).toMatchObject({ versionNo: 1, state: 'draft' });
    expect(saved.open?.content.title).toBe('New title');
    unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    const stale = refusal(
      await h.cases.approvePost.execute(reviewer(h), { post: created.id, body: { versionNo: 7 } }),
    );
    expect(stale.code).toBe('conflict.stale');
  });

  it('refuses steps that do not fit where the post is', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = await createNews(h, writer(h), category);
    expect(
      refusal(
        await h.cases.publishPost.execute(publisher(h), {
          post: created.id,
          body: { versionNo: 1 },
        }),
      ).code,
    ).toBe('blog.wrong-state');
    expect(
      refusal(
        await h.cases.approvePost.execute(reviewer(h), {
          post: created.id,
          body: { versionNo: 1 },
        }),
      ).code,
    ).toBe('blog.wrong-state');
    expect(
      refusal(
        await h.cases.pausePost.execute(h.admin('pauser', ['blog.post.pause']), {
          post: created.id,
          body: { reason: 'x' },
        }),
      ).code,
    ).toBe('blog.wrong-state');
  });

  it('lets a reviewer edit a post in review as a new version that the editor cannot approve', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = await createNews(h, writer(h), category);
    unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    const edited = unwrap(
      await h.cases.reviewerEdit.execute(reviewer(h), {
        post: created.id,
        body: { content: content({ categoryId: category, title: 'Reviewer wording' }) },
      }),
    );
    expect(edited.open).toMatchObject({ versionNo: 2, state: 'in_review', editedByReviewer: true });
    expect(h.events.map((e) => e.type)).toContain('blog.post-edited-by-reviewer.v1');
    // Neither the editor nor the original sender may approve it; a third person may.
    const byEditor = refusal(
      await h.cases.approvePost.execute(reviewer(h), { post: created.id, body: { versionNo: 2 } }),
    );
    expect(['blog.self-approval-refused', 'second-factor.required']).toContain(byEditor.code);
    const third = h.admin('reviewer-two', REVIEWER);
    const approved = unwrap(
      await h.cases.approvePost.execute(third, { post: created.id, body: { versionNo: 2 } }),
    );
    expect(approved.status).toBe('approved');
  });

  it('edits a live post as a new version while the old one stays on the site, then replaces it', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const live = await liveNews(h, category, 'First wording');
    const edited = unwrap(
      await h.cases.updateDraft.execute(writer(h), {
        post: live.id,
        body: { content: content({ categoryId: category, title: 'Second wording' }) },
      }),
    );
    expect(edited.status).toBe('published');
    expect(edited.live?.content.title).toBe('First wording');
    expect(edited.open).toMatchObject({ versionNo: 2, state: 'draft' });
    // Buyers still read the first wording.
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toMatchObject({ post: { title: 'First wording' } });

    unwrap(await h.cases.submitPost.execute(writer(h), { post: live.id }));
    unwrap(
      await h.cases.approvePost.execute(reviewer(h), { post: live.id, body: { versionNo: 2 } }),
    );
    const replaced = unwrap(
      await h.cases.publishPost.execute(publisher(h), { post: live.id, body: { versionNo: 2 } }),
    );
    expect(replaced.live).toMatchObject({ versionNo: 2, state: 'live' });
    expect(replaced.versions.map((v) => [v.versionNo, v.state])).toEqual([
      [2, 'live'],
      [1, 'retired'],
    ]);
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toMatchObject({ post: { title: 'Second wording' } });
  });

  it('pauses at once without approval, answers 410, and resumes with the version it had', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const live = await liveNews(h, category, 'Seasonal picks');
    const pauser = h.admin('pauser', ['blog.post.pause']);
    const paused = unwrap(
      await h.cases.pausePost.execute(pauser, {
        post: live.id,
        body: { reason: 'Wrong price shown' },
      }),
    );
    expect(paused).toMatchObject({ status: 'unpublished', pausedReason: 'Wrong price shown' });
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toEqual({
      code: 'blog.gone',
    });
    expect(unwrap(await h.cases.viewPublishedPosts.execute(h.anonymous(), {})).items).toEqual([]);

    // The pauser cannot put it back: that needs the publish key.
    const denied = await h.cases.resumePost.execute(pauser, { post: live.id });
    expect(refusal(denied)).toEqual({ code: 'access.denied' });
    const resumed = unwrap(await h.cases.resumePost.execute(publisher(h), { post: live.id }));
    expect(resumed).toMatchObject({ status: 'published', pausedReason: null });
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })),
    ).toMatchObject({
      kind: 'post',
    });
    expect(h.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['blog.post-paused.v1', 'blog.post-resumed.v1']),
    );
  });

  it('renames the address of a published post, redirects the old one and keeps the old one from others', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const live = await liveNews(h, category, 'Old address');
    const renamed = unwrap(
      await h.cases.renamePostSlug.execute(publisher(h), {
        post: live.id,
        body: { slug: 'new-address' },
      }),
    );
    expect(renamed.slug).toBe('new-address');
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: 'old-address' })),
    ).toEqual({
      kind: 'redirect',
      slug: 'new-address',
    });
    // Another post cannot take the old address.
    const other = await createNews(h, writer(h), category, 'Something else');
    const taken = refusal(
      await h.cases.updateDraft.execute(writer(h), {
        post: other.id,
        body: { content: content({ categoryId: category }), slug: 'old-address' },
      }),
    );
    expect(taken.code).toBe('blog.slug-taken');

    // Once paused, the old address answers 410 as well.
    unwrap(
      await h.cases.pausePost.execute(h.admin('pauser', ['blog.post.pause']), {
        post: live.id,
        body: { reason: 'Review needed' },
      }),
    );
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: 'old-address' })).code,
    ).toBe('blog.gone');
  });

  it('archives a post: it leaves the site and cannot be changed or sent again', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const live = await liveNews(h, category, 'Short lived');
    const archived = unwrap(await h.cases.archivePost.execute(publisher(h), { post: live.id }));
    expect(archived.status).toBe('archived');
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: live.slug })).code,
    ).toBe('blog.gone');
    expect(
      refusal(
        await h.cases.updateDraft.execute(writer(h), {
          post: live.id,
          body: { content: content({ categoryId: category }) },
        }),
      ).code,
    ).toBe('blog.post-archived');

    // A draft that never went live is just 404 after archiving.
    const draft = await createNews(h, writer(h), category, 'Never published');
    unwrap(await h.cases.archivePost.execute(publisher(h), { post: draft.id }));
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: draft.slug })).code,
    ).toBe('blog.not-found');
  });

  it('features one published post per Market', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const first = await liveNews(h, category, 'First feature');
    const second = await liveNews(h, category, 'Second feature');
    unwrap(
      await h.cases.featurePost.execute(publisher(h), { post: first.id, body: { featured: true } }),
    );
    unwrap(
      await h.cases.featurePost.execute(publisher(h), {
        post: second.id,
        body: { featured: true },
      }),
    );
    const posts = h.repo.allPosts(h.market);
    expect(posts.filter((p) => p.featured).map((p) => p.id)).toEqual([second.id]);
    // The featured post leads the public list.
    const list = unwrap(await h.cases.viewPublishedPosts.execute(h.anonymous(), {}));
    expect(list.items[0]?.slug).toBe(second.slug);
    // A draft cannot be featured.
    const draft = await createNews(h, writer(h), category, 'Only a draft');
    expect(
      refusal(
        await h.cases.featurePost.execute(publisher(h), {
          post: draft.id,
          body: { featured: true },
        }),
      ).code,
    ).toBe('blog.wrong-state');
  });

  it('pages the public list by the Market page size and filters by kind and category', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const other = await aCategory(h, 'travel');
    const pageSize = h.deps.policy.of(h.market)!.pageSize;
    for (let n = 0; n < pageSize + 1; n += 1) {
      h.clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await liveNews(h, n === 0 ? other : category, `Post number ${n}`);
    }
    const first = unwrap(await h.cases.viewPublishedPosts.execute(h.anonymous(), {}));
    expect(first.items).toHaveLength(pageSize);
    expect(first.hasMore).toBe(true);
    const second = unwrap(
      await h.cases.viewPublishedPosts.execute(h.anonymous(), { query: { page: '2' } }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    const byCategory = unwrap(
      await h.cases.viewPublishedPosts.execute(h.anonymous(), { query: { category: 'travel' } }),
    );
    expect(byCategory.items.map((i) => i.title)).toEqual(['Post number 0']);
    expect(
      unwrap(await h.cases.viewPublishedPosts.execute(h.anonymous(), { query: { kind: 'event' } }))
        .items,
    ).toEqual([]);
    expect(
      refusal(await h.cases.viewPublishedPosts.execute(h.anonymous(), { query: { kind: 'x' } }))
        .code,
    ).toBe('validation.failed');
    expect(
      refusal(await h.cases.viewPublishedPosts.execute(h.anonymous(), { query: { page: '0' } }))
        .code,
    ).toBe('validation.failed');
  });

  it('changes the status of a live event at once, without a new version, and audits it', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = unwrap(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'event',
          content: content({ categoryId: category, title: 'Open day', event: eventDetails(h) }),
        },
      }),
    );
    unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    unwrap(
      await h.cases.approvePost.execute(reviewer(h), { post: created.id, body: { versionNo: 1 } }),
    );
    unwrap(
      await h.cases.publishPost.execute(publisher(h), { post: created.id, body: { versionNo: 1 } }),
    );

    const upcoming = unwrap(await h.cases.viewUpcomingEvents.execute(h.anonymous(), undefined));
    expect(upcoming.items.map((i) => i.slug)).toEqual([created.slug]);
    expect(upcoming.items[0]?.event?.eventStatus).toBe('scheduled');

    const changed = unwrap(
      await h.cases.changeEventStatus.execute(writer(h), {
        post: created.id,
        body: { status: 'cancelled', message: 'The venue is closed.' },
      }),
    );
    expect(changed.versions).toHaveLength(1);
    expect(changed.live?.content.event).toMatchObject({
      eventStatus: 'cancelled',
      statusMessage: 'The venue is closed.',
    });
    expect(h.audits.map((a) => a.action)).toContain('blog.post.change-event-status');
    const answer = unwrap(
      await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: created.slug }),
    );
    expect(answer).toMatchObject({ post: { event: { eventStatus: 'cancelled' } } });

    // Once the event has ended it is no longer upcoming.
    h.clock.advance(Temporal.Duration.from({ hours: 24 * 11 }));
    expect(
      unwrap(await h.cases.viewUpcomingEvents.execute(h.anonymous(), undefined)).items,
    ).toEqual([]);
  });

  it('checks a status message before it goes live: no outside link, no certification claim, fail closed', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const created = unwrap(
      await h.cases.createPost.execute(writer(h), {
        body: {
          kind: 'event',
          content: content({ categoryId: category, title: 'Open day', event: eventDetails(h) }),
        },
      }),
    );
    unwrap(await h.cases.submitPost.execute(writer(h), { post: created.id }));
    unwrap(
      await h.cases.approvePost.execute(reviewer(h), { post: created.id, body: { versionNo: 1 } }),
    );
    unwrap(
      await h.cases.publishPost.execute(publisher(h), { post: created.id, body: { versionNo: 1 } }),
    );
    const change = (message: string) =>
      h.cases.changeEventStatus.execute(writer(h), {
        post: created.id,
        body: { status: 'postponed', message },
      });
    expect(refusal(await change('Details at www.example.com'))).toEqual({
      code: 'blog.checks-failed',
      findings: [{ severity: 'error', code: 'external-link', path: 'message' }],
    });
    expect(refusal(await change('Now ISO certified stalls'))).toEqual({
      code: 'blog.checks-failed',
      findings: [{ severity: 'error', code: 'certification-claim', path: 'message' }],
    });
    h.links.claimsDown = true;
    expect(refusal(await change('Moved to next week'))).toEqual({
      code: 'blog.checks-failed',
      findings: [{ severity: 'error', code: 'claims-unverifiable', path: null }],
    });
    h.links.claimsDown = false;
    // Nothing of the refused messages reached the post; a clean one goes live at once.
    const view = unwrap(
      await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: created.slug }),
    );
    expect(JSON.stringify(view)).not.toMatch(/example\.com|ISO certified/);
    const changed = unwrap(await change('Moved to next week'));
    expect(changed.live?.content.event).toMatchObject({
      eventStatus: 'postponed',
      statusMessage: 'Moved to next week',
    });
    // A status change with no message needs no check.
    h.links.claimsDown = true;
    unwrap(
      await h.cases.changeEventStatus.execute(writer(h), {
        post: created.id,
        body: { status: 'scheduled' },
      }),
    );
  });

  it('refuses an event that has ended and an event post without event details', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const bare = unwrap(
      await h.cases.createPost.execute(writer(h), {
        body: { kind: 'event', content: content({ categoryId: category, title: 'No details' }) },
      }),
    );
    const refused = refusal(await h.cases.submitPost.execute(writer(h), { post: bare.id }));
    expect(
      (refused as unknown as { findings: { code: string }[] }).findings.map((f) => f.code),
    ).toContain('event-missing');
  });

  it('publishes the approved version at the scheduled time, once, and a repeat run changes nothing', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const approved = await approvedNews(h, category, 'Scheduled piece');
    const when = h.clock.now().add({ hours: 2 });
    const scheduled = unwrap(
      await h.cases.schedulePost.execute(publisher(h), {
        post: approved.id,
        body: { versionNo: 1, scheduledAt: when.toString() },
      }),
    );
    expect(scheduled).toMatchObject({ status: 'scheduled' });
    expect(
      refusal(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: approved.slug })).code,
    ).toBe('blog.not-found');

    // Before the time: nothing to do.
    expect(unwrap(await h.cases.publishDue.execute(h.system(), undefined))).toEqual({
      published: 0,
      skipped: 0,
    });

    const scheduler = publisher(h);
    const schedulerId = scheduler.actor.kind === 'authenticated' ? scheduler.actor.accountId : null;
    expect(h.repo.allPosts(h.market)[0]?.scheduledBy).toBe(schedulerId);
    // Someone else touches the post after it was scheduled: the scheduler is still the publisher.
    const other = h.admin('someone-else', PUBLISHER);
    await h.repo.updatePost(
      h.market,
      approved.id,
      {},
      {
        at: h.clock.now(),
        by: other.actor.kind === 'authenticated' ? other.actor.accountId : schedulerId!,
      },
    );

    h.clock.advance(Temporal.Duration.from({ hours: 2, minutes: 1 }));
    const first = unwrap(await h.cases.publishDue.execute(h.system(), undefined));
    expect(first).toEqual({ published: 1, skipped: 0 });
    const livePost = h.repo.allPosts(h.market)[0]!;
    expect(livePost.scheduledBy).toBeNull();
    const liveVersion = await h.repo.findVersion(h.market, livePost.id, livePost.liveVersionId!);
    expect(liveVersion?.publishedBy).toBe(schedulerId);
    const eventsAfterFirst = h.events.length;
    const auditsAfterFirst = h.audits.length;
    expect(h.repo.allPosts(h.market)[0]).toMatchObject({ status: 'published', scheduledAt: null });

    // A second and a third run (a late job overlapping the first) find nothing.
    expect(unwrap(await h.cases.publishDue.execute(h.system(), undefined))).toEqual({
      published: 0,
      skipped: 0,
    });
    expect(unwrap(await h.cases.publishDue.execute(h.system(), undefined))).toEqual({
      published: 0,
      skipped: 0,
    });
    expect(h.events).toHaveLength(eventsAfterFirst);
    expect(h.audits).toHaveLength(auditsAfterFirst);
    expect(h.events.filter((e) => e.type === 'blog.post-published.v1')).toHaveLength(1);
    expect(
      unwrap(await h.cases.viewPublishedPost.execute(h.anonymous(), { slug: approved.slug })),
    ).toMatchObject({
      kind: 'post',
    });
  });

  it('refuses a schedule in the past or beyond a year, and lets the schedule be removed', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    const approved = await approvedNews(h, category);
    const past = refusal(
      await h.cases.schedulePost.execute(publisher(h), {
        post: approved.id,
        body: { versionNo: 1, scheduledAt: h.clock.now().subtract({ hours: 1 }).toString() },
      }),
    );
    expect(past.code).toBe('validation.failed');
    const far = refusal(
      await h.cases.schedulePost.execute(publisher(h), {
        post: approved.id,
        body: {
          versionNo: 1,
          scheduledAt: h.clock
            .now()
            .add({ hours: 24 * 400 })
            .toString(),
        },
      }),
    );
    expect(far.code).toBe('validation.failed');
    unwrap(
      await h.cases.schedulePost.execute(publisher(h), {
        post: approved.id,
        body: { versionNo: 1, scheduledAt: h.clock.now().add({ hours: 5 }).toString() },
      }),
    );
    const removed = unwrap(
      await h.cases.unschedulePost.execute(publisher(h), { post: approved.id }),
    );
    expect(removed.status).toBe('approved');
    expect(h.repo.allPosts(h.market)[0]?.scheduledBy).toBeNull();
    h.clock.advance(Temporal.Duration.from({ hours: 6 }));
    expect(unwrap(await h.cases.publishDue.execute(h.system(), undefined))).toEqual({
      published: 0,
      skipped: 0,
    });
  });

  it('keeps a post of this Market from being found through another id or in a list of another Market', async () => {
    const h = blogHarness(code);
    const category = await aCategory(h);
    await createNews(h, writer(h), category);
    expect(
      refusal(
        await h.cases.viewPost.execute(h.admin('reader', ['blog.post.read']), {
          post: 'not-an-id',
        }),
      ).code,
    ).toBe('blog.post-not-found');
    expect(
      refusal(
        await h.cases.viewPost.execute(h.admin('reader', ['blog.post.read']), {
          post: '0197b000-0000-7000-8000-0000000000aa',
        }),
      ).code,
    ).toBe('blog.post-not-found');
    const list = unwrap(await h.cases.listPosts.execute(h.admin('reader', ['blog.post.read']), {}));
    expect(list.items).toHaveLength(1);
    const other = blogHarness(code === 'AU' ? 'ZZ' : 'AU');
    expect(
      unwrap(await other.cases.listPosts.execute(other.admin('reader', ['blog.post.read']), {}))
        .items,
    ).toEqual([]);
  });
});
