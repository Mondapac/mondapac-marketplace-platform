import {
  editModeOf,
  isPublic,
  POST_ACTIONS,
  publicAbsence,
  refusalFor,
  stageOf,
  statusAfter,
} from './lifecycle';
import type { PostFacts } from './lifecycle';

const post = (change: Partial<PostFacts>): PostFacts => ({
  status: 'draft',
  hasLive: false,
  open: 'draft',
  everPublished: false,
  scheduled: false,
  ...change,
});

describe('post lifecycle', () => {
  it('lets only a draft be sent for review, and only a version in review be decided', () => {
    expect(refusalFor('submit', post({}))).toBeNull();
    expect(refusalFor('submit', post({ status: 'in_review', open: 'in_review' }))).toBe(
      'blog.wrong-state',
    );
    for (const action of ['approve', 'request-changes', 'reviewer-edit'] as const) {
      expect(refusalFor(action, post({ status: 'in_review', open: 'in_review' }))).toBeNull();
      expect(refusalFor(action, post({}))).toBe('blog.wrong-state');
    }
  });

  it('publishes or schedules only an approved version, and not around a pause', () => {
    const approved = post({ status: 'approved', open: 'approved' });
    expect(refusalFor('publish', approved)).toBeNull();
    expect(refusalFor('schedule', approved)).toBeNull();
    expect(refusalFor('publish', post({}))).toBe('blog.wrong-state');
    expect(
      refusalFor(
        'publish',
        post({ status: 'unpublished', hasLive: true, everPublished: true, open: 'approved' }),
      ),
    ).toBe('blog.wrong-state');
  });

  it('pauses a published post and resumes a paused one', () => {
    const live = post({ status: 'published', hasLive: true, everPublished: true, open: null });
    expect(refusalFor('pause', live)).toBeNull();
    expect(refusalFor('resume', live)).toBe('blog.wrong-state');
    expect(refusalFor('resume', { ...live, status: 'unpublished' })).toBeNull();
    expect(refusalFor('pause', post({}))).toBe('blog.wrong-state');
  });

  it('refuses everything on an archived post', () => {
    const archived = post({ status: 'archived' });
    for (const action of POST_ACTIONS)
      expect(refusalFor(action, archived)).toBe('blog.post-archived');
  });

  it('renames a slug and features only what was published', () => {
    const live = post({ status: 'published', hasLive: true, everPublished: true, open: null });
    expect(refusalFor('rename-slug', live)).toBeNull();
    expect(refusalFor('rename-slug', post({}))).toBe('blog.wrong-state');
    expect(refusalFor('feature', live)).toBeNull();
    expect(refusalFor('feature', { ...live, status: 'unpublished' })).toBe('blog.wrong-state');
  });

  it('unschedules only a scheduled post', () => {
    expect(
      refusalFor('unschedule', post({ status: 'scheduled', open: 'approved', scheduled: true })),
    ).toBeNull();
    expect(refusalFor('unschedule', post({ status: 'approved', open: 'approved' }))).toBe(
      'blog.wrong-state',
    );
  });

  it('edits a draft in place and starts a new draft from a returned, approved or live version', () => {
    expect(editModeOf(post({}))).toBe('in-place');
    expect(editModeOf(post({ status: 'changes_requested', open: 'returned' }))).toBe('new-draft');
    expect(editModeOf(post({ status: 'approved', open: 'approved' }))).toBe('new-draft');
    expect(
      editModeOf(post({ status: 'published', hasLive: true, everPublished: true, open: null })),
    ).toBe('new-draft');
    expect(editModeOf(post({ status: 'in_review', open: 'in_review' }))).toBeNull();
    expect(editModeOf(post({ status: 'archived' }))).toBeNull();
  });

  it('moves the working status of a post that was never live, and keeps the status of one that was', () => {
    expect(statusAfter('submit', post({}))).toBe('in_review');
    expect(statusAfter('approve', post({ open: 'in_review' }))).toBe('approved');
    expect(statusAfter('request-changes', post({ open: 'in_review' }))).toBe('changes_requested');
    expect(statusAfter('schedule', post({ open: 'approved' }))).toBe('scheduled');
    expect(statusAfter('unschedule', post({ status: 'scheduled', open: 'approved' }))).toBe(
      'approved',
    );
    expect(statusAfter('new-draft', post({ status: 'approved', open: 'approved' }))).toBe('draft');
    const live = post({ status: 'published', hasLive: true, everPublished: true, open: 'draft' });
    expect(statusAfter('submit', live)).toBe('published');
    expect(statusAfter('new-draft', { ...live, status: 'unpublished' })).toBe('unpublished');
  });

  it('names the stage of the open version for authors and reviewers', () => {
    expect(stageOf(post({}))).toBe('draft');
    expect(stageOf(post({ open: 'returned' }))).toBe('changes-requested');
    expect(stageOf(post({ open: null }))).toBe('none');
  });

  it('answers a public read: live is public, a paused or archived live post is gone, others are not found', () => {
    expect(isPublic({ status: 'published', hasLive: true })).toBe(true);
    expect(isPublic({ status: 'unpublished', hasLive: true })).toBe(false);
    expect(publicAbsence({ status: 'unpublished', everPublished: true })).toBe('gone');
    expect(publicAbsence({ status: 'archived', everPublished: true })).toBe('gone');
    expect(publicAbsence({ status: 'archived', everPublished: false })).toBe('not-found');
    expect(publicAbsence({ status: 'draft', everPublished: false })).toBe('not-found');
  });
});
