import { Temporal } from '@mondapac/shared-kernel';
import {
  canEditReply,
  canReplyToStatus,
  validateReplyInput,
  validateReportReason,
} from './seller-reply';

const limits = { bodyMaxLength: 10 };
const at = (iso: string) => Temporal.Instant.from(iso);

describe('validateReplyInput', () => {
  it('trims and accepts a body within the Market limit', () => {
    expect(validateReplyInput({ body: '  thanks  ' }, limits)).toEqual({ ok: true, value: 'thanks' });
  });
  it('counts people-visible characters, not UTF-16 units', () => {
    expect(validateReplyInput({ body: '😀'.repeat(10) }, limits).ok).toBe(true);
    expect(validateReplyInput({ body: '😀'.repeat(11) }, limits)).toEqual({
      ok: false,
      error: [{ path: 'body', code: 'length' }],
    });
  });
  it('refuses a missing, empty or non-text body', () => {
    for (const input of [undefined, {}, { body: '   ' }, { body: 4 }]) {
      expect(validateReplyInput(input, limits).ok).toBe(false);
    }
  });
});

describe('validateReportReason', () => {
  it('accepts only the closed list', () => {
    expect(validateReportReason({ reasonCode: 'extortion' }).ok).toBe(true);
    expect(validateReportReason({ reasonCode: 'dislike' }).ok).toBe(false);
    expect(validateReportReason(null).ok).toBe(false);
  });
});

describe('canEditReply', () => {
  const created = at('2026-11-01T00:00:00Z');
  it('allows an edit up to and including the last instant of the window', () => {
    expect(canEditReply(created, at('2026-11-08T00:00:00Z'), 7)).toBe(true);
    expect(canEditReply(created, at('2026-11-08T00:00:01Z'), 7)).toBe(false);
  });
  it('follows the Market value, not a constant', () => {
    expect(canEditReply(created, at('2026-11-04T00:00:01Z'), 3)).toBe(false);
  });
});

describe('canReplyToStatus', () => {
  it('only a published review takes a reply', () => {
    expect(canReplyToStatus('published')).toBe(true);
    for (const s of ['held', 'hidden', 'removed', 'deleted-by-author']) {
      expect(canReplyToStatus(s)).toBe(false);
    }
  });
});
