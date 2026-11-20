import { describe, expect, it } from 'vitest';
import { parseQueueTab, queueHref, revisionHref } from './review-queue-params.ts';

describe('review queue address', () => {
  it('opens Offers for ?type=offer and the revisions for anything else', () => {
    expect(parseQueueTab({ type: 'offer' })).toBe('offer');
    expect(parseQueueTab({ type: 'revision' })).toBe('revision');
    expect(parseQueueTab({ type: ['offer'] })).toBe('revision');
    expect(parseQueueTab({})).toBe('revision');
  });
  it('links each tab and one version review', () => {
    expect(queueHref('revision')).toBe('/review');
    expect(queueHref('offer')).toBe('/review?type=offer');
    expect(revisionHref({ productId: 'p1', revisionId: 'r1' })).toBe(
      '/review/products/p1/revisions/r1',
    );
  });
});
