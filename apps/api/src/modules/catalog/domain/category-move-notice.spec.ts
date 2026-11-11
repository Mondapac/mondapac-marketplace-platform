import { Temporal } from '@mondapac/shared-kernel';
import {
  categoryMoveNoticeMail,
  MAX_MOVE_NOTICE_ATTEMPTS,
  moveNoticeRetryAt,
} from './category-move-notice';

describe('moveNoticeRetryAt', () => {
  const now = Temporal.Instant.from('2026-11-11T00:00:00Z');
  it('backs off 5, 10, 20, 40 minutes and gives up at the last attempt', () => {
    const waits = [0, 1, 2, 3].map((sofar) =>
      moveNoticeRetryAt(sofar, now)!.since(now).total({ unit: 'minutes' }),
    );
    expect(waits).toEqual([5, 10, 20, 40]);
    expect(moveNoticeRetryAt(MAX_MOVE_NOTICE_ATTEMPTS - 1, now)).toBeNull();
    expect(moveNoticeRetryAt(MAX_MOVE_NOTICE_ATTEMPTS + 3, now)).toBeNull();
  });
});

describe('categoryMoveNoticeMail', () => {
  it('names the product and both categories and nothing else', () => {
    const mail = categoryMoveNoticeMail({
      productCode: 'P00000042',
      fromName: 'Dates',
      toName: 'Fresh dates',
    });
    expect(mail.subject).toBe('The category of your product P00000042 changed');
    expect(mail.text).toContain('from the category "Dates" to "Fresh dates"');
  });
  it('makes every name one line and strips control and format characters', () => {
    const mail = categoryMoveNoticeMail({
      productCode: 'P1\n',
      fromName: 'A‮B\r\nC',
      toName: '​D',
    });
    expect(mail.subject).not.toMatch(/[\n\r‮]/u);
    expect(mail.text).toContain('"A B C"');
    expect(mail.text).toContain('"D"');
  });
});
