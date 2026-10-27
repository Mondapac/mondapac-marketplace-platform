import { Temporal } from '@mondapac/shared-kernel';
import {
  blockCountDay,
  blockCountRetentionEdge,
  incrementsOf,
  MAX_BLOCK_EVENTS,
  readBlockEvents,
} from './block-count';

// The body of the block-count route: 1 to 20 closed events with canonical ids, identical events
// counted once, grouped per block in a fixed order; days are UTC; retention is 13 months.

const PAGE = '01990000-0000-7000-8000-0000000000a1';
const PAGE_2 = '01990000-0000-7000-8000-0000000000a2';
const BLOCK = '01990000-0000-7000-8000-0000000000b1';
const BLOCK_2 = '01990000-0000-7000-8000-0000000000b2';
const event = (overrides: Record<string, unknown> = {}) => ({
  pageId: PAGE,
  placementId: BLOCK,
  type: 'impression',
  ...overrides,
});
const problems = (events: unknown) => {
  const read = readBlockEvents(events);
  if (read.ok) throw new Error('expected a refusal');
  return read.fields;
};

describe('reading the events of a request', () => {
  it('reads valid events of both types', () => {
    const read = readBlockEvents([event(), event({ type: 'click' })]);
    expect(read).toEqual({
      ok: true,
      events: [
        { pageId: PAGE, placementId: BLOCK, type: 'impression' },
        { pageId: PAGE, placementId: BLOCK, type: 'click' },
      ],
    });
  });

  it('counts identical events of one request once, keeping the first appearance', () => {
    const read = readBlockEvents([
      event(),
      event({ placementId: BLOCK_2 }),
      event(),
      event({ placementId: BLOCK_2 }),
    ]);
    expect(read.ok && read.events.map((e) => e.placementId)).toEqual([BLOCK, BLOCK_2]);
  });

  it('needs 1 to 20 events', () => {
    expect(problems(undefined)).toEqual([{ path: 'events', code: 'required' }]);
    expect(problems('x')).toEqual([{ path: 'events', code: 'type' }]);
    expect(problems({})).toEqual([{ path: 'events', code: 'type' }]);
    expect(problems([])).toEqual([{ path: 'events', code: 'too-few' }]);
    const twenty = Array.from({ length: MAX_BLOCK_EVENTS }, (_, n) =>
      event({
        placementId: `01990000-0000-7000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`,
      }),
    );
    expect(readBlockEvents(twenty).ok).toBe(true);
    // Twenty-one identical events are still too many: the limit is on what was sent.
    expect(problems([...twenty, event()])).toEqual([{ path: 'events', code: 'too-many' }]);
    expect(problems(Array.from({ length: 21 }, () => event()))).toEqual([
      { path: 'events', code: 'too-many' },
    ]);
  });

  it('accepts 20 events with many duplicates, and refuses 21 with one duplicate', () => {
    const distinct = Array.from({ length: 5 }, (_, n) =>
      event({
        placementId: `01990000-0000-7000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`,
      }),
    );
    const twenty = Array.from({ length: MAX_BLOCK_EVENTS }, (_, n) => distinct[n % 5]);
    const read = readBlockEvents(twenty);
    expect(read.ok && read.events).toHaveLength(5);
    // The limit is on what was sent: 21 entries with a single duplicate are still too many.
    expect(problems([...distinct, ...distinct, ...distinct, ...distinct, distinct[0]])).toEqual([
      { path: 'events', code: 'too-many' },
    ]);
  });

  it('keeps the same placement on two pages, and an impression and a click on one block', () => {
    const read = readBlockEvents([
      event(),
      event({ pageId: PAGE_2 }),
      event({ type: 'click' }),
      event({ pageId: PAGE_2 }),
    ]);
    expect(read.ok && read.events.map((e) => `${e.pageId}|${e.type}`)).toEqual([
      `${PAGE}|impression`,
      `${PAGE_2}|impression`,
      `${PAGE}|click`,
    ]);
  });

  it('names at most 2 distinct pages', () => {
    const PAGE_3 = '01990000-0000-7000-8000-0000000000a3';
    expect(readBlockEvents([event(), event({ pageId: PAGE_2 }), event({ type: 'click' })]).ok).toBe(
      true,
    );
    expect(problems([event(), event({ pageId: PAGE_2 }), event({ pageId: PAGE_3 })])).toEqual([
      { path: 'events', code: 'too-many-pages' },
    ]);
    // A malformed event is reported by itself first, not as a page problem.
    expect(
      problems([
        event(),
        event({ pageId: PAGE_2 }),
        event({ pageId: PAGE_3 }),
        event({ type: 'x' }),
      ]),
    ).toEqual([{ path: 'events.3.type', code: 'one-of' }]);
  });

  it('refuses an event that is not a closed object, without echoing a key or a value', () => {
    expect(problems([event({ accountId: 'secret-value' })])).toEqual([
      { path: 'events.0', code: 'unknown-field' },
    ]);
    expect(problems([event(), 'x', null, [], 5])).toEqual([
      { path: 'events.1', code: 'type' },
      { path: 'events.2', code: 'type' },
      { path: 'events.3', code: 'type' },
      { path: 'events.4', code: 'type' },
    ]);
    expect(JSON.stringify(problems([event({ userAgent: 'x' })]))).not.toContain('userAgent');
  });

  it('refuses a missing or malformed id and an unknown type', () => {
    expect(problems([{ type: 'click' }])).toEqual([
      { path: 'events.0.pageId', code: 'required' },
      { path: 'events.0.placementId', code: 'required' },
    ]);
    expect(
      problems([
        event({ pageId: 'not-a-uuid' }),
        event({ placementId: BLOCK.toUpperCase() }),
        event({ pageId: 5 }),
        event({ type: 'view' }),
        event({ type: undefined }),
        event({ type: ['click'] }),
      ]),
    ).toEqual([
      { path: 'events.0.pageId', code: 'format' },
      { path: 'events.1.placementId', code: 'format' },
      { path: 'events.2.pageId', code: 'format' },
      { path: 'events.3.type', code: 'one-of' },
      { path: 'events.4.type', code: 'required' },
      { path: 'events.5.type', code: 'one-of' },
    ]);
  });
});

describe('grouping and days', () => {
  it('groups events per block and orders them by page then placement', () => {
    const read = readBlockEvents([
      event({ pageId: PAGE_2, placementId: BLOCK }),
      event({ placementId: BLOCK_2, type: 'click' }),
      event({ placementId: BLOCK_2 }),
      event({ placementId: BLOCK }),
    ]);
    if (!read.ok) throw new Error('valid');
    expect(incrementsOf(read.events)).toEqual([
      { pageId: PAGE, placementId: BLOCK, impressions: 1, clicks: 0 },
      { pageId: PAGE, placementId: BLOCK_2, impressions: 1, clicks: 1 },
      { pageId: PAGE_2, placementId: BLOCK, impressions: 1, clicks: 0 },
    ]);
  });

  it('counts on the UTC day, whatever the time of day', () => {
    expect(blockCountDay(Temporal.Instant.from('2026-10-25T23:59:59Z')).toString()).toBe(
      '2026-10-25',
    );
    expect(blockCountDay(Temporal.Instant.from('2026-10-26T00:00:00Z')).toString()).toBe(
      '2026-10-26',
    );
  });

  it('keeps 13 months: rows of days before today minus 13 calendar months are past retention', () => {
    expect(blockCountRetentionEdge(Temporal.Instant.from('2026-10-25T10:00:00Z')).toString()).toBe(
      '2025-09-25',
    );
    // The end of a month clamps to the shorter month.
    expect(blockCountRetentionEdge(Temporal.Instant.from('2026-03-31T10:00:00Z')).toString()).toBe(
      '2025-02-28',
    );
  });
});
