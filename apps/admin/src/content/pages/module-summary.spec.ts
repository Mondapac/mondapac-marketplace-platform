import { describe, expect, it } from 'vitest';
import { summaryOf, type Say } from './module-summary.ts';
import { placement } from './test-data.ts';

const say: Say = (key, values) =>
  `${key}${values === undefined ? '' : ` ${JSON.stringify(values)}`}`;
const line = (module: string, config: Record<string, unknown>) =>
  summaryOf(placement({ id: 'x', module, config }), say);

describe('module summaries', () => {
  it('names a banner, a brand and an image block by their own words', () => {
    expect(line('banner', { title: 'Eid' })).toBe('Eid');
    expect(line('brand-header', { name: 'Fresh Co' })).toBe('Fresh Co');
    expect(line('image-text', { heading: 'Our story' })).toBe('Our story');
  });

  it('tells shelves apart by source and size', () => {
    expect(line('product-shelf', { source: { kind: 'specials' }, limit: 6 })).toBe(
      'summary-shelf {"source":"source-name-specials","limit":6}',
    );
  });

  it('shows the first words of a text block', () => {
    expect(
      line('text-block', {
        blocks: [
          { type: 'heading', level: 2, text: 'Opening hours' },
          { type: 'paragraph', spans: [{ text: 'Open daily' }] },
        ],
      }),
    ).toBe('Opening hours');
    expect(
      line('text-block', {
        blocks: [{ type: 'paragraph', spans: [{ text: 'Open' }, { text: 'daily' }] }],
      }),
    ).toBe('Open daily');
    expect(line('text-block', { blocks: [{ type: 'list', items: [[{ text: 'One' }]] }] })).toBe(
      'One',
    );
  });

  it('counts items and questions', () => {
    expect(line('info-strip', { items: [{ icon: 'tax' }, { icon: 'local' }] })).toBe(
      'summary-strip {"count":2}',
    );
    expect(line('faq', { items: [{}, {}, {}] })).toBe('summary-faq {"count":3}');
    expect(line('faq', { title: 'Questions', items: [{}] })).toBe('Questions');
  });

  it('says what a circle row and a spotlight show when nothing is typed', () => {
    expect(line('category-circles', {})).toBe('');
    expect(line('category-circles', { categoryIds: ['a', 'b'] })).toBe(
      'summary-circles-chosen {"count":2}',
    );
    expect(line('product-spotlight', {})).toBe('summary-spotlight');
    expect(line('sellers-near-you', {})).toBe('summary-sellers {"limit":8}');
  });

  it('has no line for a module it does not know', () => {
    expect(line('mystery', { title: 'x' })).toBe('');
  });
});
