import { REVIEW_STATUSES } from './rules';
import {
  HIDE_REASON_CODES,
  isReasonFor,
  MODERATOR_ACTIONS,
  REASONS_BY_ACTION,
  statusAfter,
} from './moderation';

describe('moderator transitions', () => {
  it('publishes only a held review and restores only a hidden one', () => {
    expect(statusAfter('publish', 'held')).toBe('published');
    expect(statusAfter('restore', 'hidden')).toBe('published');
    for (const from of REVIEW_STATUSES) {
      if (from !== 'held') expect(statusAfter('publish', from)).toBeNull();
      if (from !== 'hidden') expect(statusAfter('restore', from)).toBeNull();
    }
  });

  it('hides a live review and removes anything not already removed or deleted', () => {
    expect(statusAfter('hide', 'published')).toBe('hidden');
    expect(statusAfter('hide', 'held')).toBe('hidden');
    expect(statusAfter('hide', 'hidden')).toBeNull();
    expect(statusAfter('remove', 'hidden')).toBe('removed');
    expect(statusAfter('remove', 'removed')).toBeNull();
    expect(statusAfter('remove', 'deleted-by-author')).toBeNull();
  });

  it('nothing moves a review the author deleted, and a removed review stays removed', () => {
    for (const action of MODERATOR_ACTIONS) {
      expect(statusAfter(action, 'deleted-by-author')).toBeNull();
    }
    expect(statusAfter('restore', 'removed')).toBeNull();
    expect(statusAfter('publish', 'removed')).toBeNull();
  });

  it('dismissing reports keeps the status', () => {
    expect(statusAfter('dismiss-reports', 'published')).toBe('published');
    expect(statusAfter('dismiss-reports', 'hidden')).toBe('hidden');
  });

  it('has no reason that hides a review for being negative or at the seller request', () => {
    const all = Object.values(REASONS_BY_ACTION).flat();
    expect(all.some((code) => /negative|seller|complain|bad-rating/.test(code))).toBe(false);
    expect(HIDE_REASON_CODES).not.toContain('negative');
  });

  it('accepts only a reason of the same action', () => {
    expect(isReasonFor('hide', 'spam')).toBe(true);
    expect(isReasonFor('hide', 'illegal')).toBe(false);
    expect(isReasonFor('remove', 'illegal')).toBe(true);
    expect(isReasonFor('publish', 7)).toBe(false);
  });
});
