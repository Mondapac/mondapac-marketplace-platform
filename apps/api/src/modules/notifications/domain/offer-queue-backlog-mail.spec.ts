import { offerQueueBacklogMail } from './offer-queue-backlog-mail';

// The backlog mail text (slice 8b, Reza's review): a subject with the numbers per reason, the
// limits in the summary, and a wait line that stays true next to "more than the limit".

const limits = { count: 50, hours: 24 };
const mail = (reason: 'age' | 'size' | 'both', count: number, hours: number) =>
  offerQueueBacklogMail({ reason, limits, count, hours, marketId: 'AU' });

describe('the Offer queue backlog mail', () => {
  it('names the numbers in the subject, per reason', () => {
    expect(mail('age', 3, 25).subject).toBe(
      'Offer review queue is behind (AU): oldest waited 25 business hours',
    );
    expect(mail('size', 51, 2).subject).toBe(
      'Offer review queue is behind (AU): 51 Offers waiting',
    );
    expect(mail('both', 51, 1).subject).toBe(
      'Offer review queue is behind (AU): 51 Offers waiting, oldest 1 business hour',
    );
  });

  it('states the limits in the summary', () => {
    expect(mail('age', 3, 25).text).toContain(
      'The oldest Offer has waited more than 24 business hours, the limit in Settings.',
    );
    expect(mail('size', 51, 2).text).toContain(
      'More than 50 Offers are waiting, the limit in Settings.',
    );
    expect(
      offerQueueBacklogMail({
        reason: 'size',
        limits: { count: 1, hours: 1 },
        count: 2,
        hours: 0,
        marketId: 'ZZ',
      }).text,
    ).toContain('More than 1 Offer is waiting, the limit in Settings.');
  });

  it('never shows a wait that contradicts the limit: at least, or less than 1 hour', () => {
    // A 24.4-hour wait floors to 24 against a 24-hour limit.
    expect(mail('age', 3, 24).text).toContain(
      'Oldest Offer has waited: at least 24 business hours',
    );
    expect(mail('size', 51, 0).text).toContain(
      'Oldest Offer has waited: less than 1 business hour',
    );
    expect(mail('size', 51, 0).subject).toBe(
      'Offer review queue is behind (AU): 51 Offers waiting',
    );
    expect(mail('age', 3, 1).text).toContain('at least 1 business hour\n');
  });

  it('is plain text with every slot filled and no link', () => {
    for (const m of [mail('age', 3, 25), mail('size', 51, 0), mail('both', 90, 40)]) {
      expect(`${m.subject}\n${m.text}`).not.toMatch(/\{\w+\}|https?:|<|@/);
    }
  });
});
