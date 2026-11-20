import { Temporal } from '@mondapac/shared-kernel';
import {
  groupUnanswered,
  MAX_QUERY_CHARACTERS,
  MAX_UNANSWERED_ROWS,
  normalizeQuery,
  parseInsightsQuery,
  type UnansweredCandidate,
} from './insights';

const T0 = Temporal.Instant.from('2026-11-10T01:00:00Z');
const at = (hours: number) => T0.add({ hours });
const turn = (
  text: string,
  hours: number,
  reasons: UnansweredCandidate['reasons'] = ['no-results'],
): UnansweredCandidate => ({ text, at: at(hours), reasons });

describe('normalizeQuery', () => {
  it('folds case, punctuation, spacing and width', () => {
    expect(normalizeQuery('  Do you   sell Ghee??  ')).toBe('do you sell ghee');
    expect(normalizeQuery('DO you sell ghee!')).toBe('do you sell ghee');
    expect(normalizeQuery('ｄｏ you sell ｇｈｅｅ')).toBe('do you sell ghee');
  });

  it('keeps Persian letters, and drops marks and zero-width characters', () => {
    expect(normalizeQuery('گوشت  بره، تازه؟')).toBe('گوشت بره تازه');
    expect(normalizeQuery('گوشت‌بره')).toBe('گوشت بره');
  });

  it('is empty when nothing is left', () => {
    expect(normalizeQuery(' ?! … ')).toBe('');
  });
});

describe('groupUnanswered', () => {
  it('groups by normalized query: most asked first, then newest, showing the newest wording', () => {
    const rows = groupUnanswered([
      turn('Is there lamb?', 1),
      turn('IS THERE LAMB', 5, ['thumbs-down']),
      turn('dates', 9),
      turn('is there lamb', 3, ['unavailable', 'unavailable', 'no-results']),
      turn('saffron?', 10),
    ]);
    expect(rows.map((row) => [row.query, row.count])).toEqual([
      ['IS THERE LAMB', 3],
      ['saffron?', 1],
      ['dates', 1],
    ]);
    expect(rows[0]).toMatchObject({
      lastAt: at(5),
      reasons: { unavailable: 1, 'tool-failed': 0, 'no-results': 2, 'thumbs-down': 1 },
    });
  });

  it('skips a line with nothing left after normalizing, and cuts a long query', () => {
    const long = 'a'.repeat(MAX_QUERY_CHARACTERS + 50);
    const rows = groupUnanswered([turn('?!', 1), turn(long, 2)]);
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.query]).toHaveLength(MAX_QUERY_CHARACTERS);
    expect(rows[0]!.query.endsWith('…')).toBe(true);
  });

  it('keeps the top 200 groups', () => {
    const many = Array.from({ length: MAX_UNANSWERED_ROWS + 20 }, (_, index) =>
      turn(`question number ${index}`, index),
    );
    const rows = groupUnanswered(many);
    expect(rows).toHaveLength(MAX_UNANSWERED_ROWS);
    // All ask once: the newest first.
    expect(rows[0]!.query).toBe(`question number ${MAX_UNANSWERED_ROWS + 19}`);
  });
});

describe('parseInsightsQuery', () => {
  const today = Temporal.PlainDate.from('2026-11-16');
  const parse = (query: Record<string, unknown>) => parseInsightsQuery(query, today);

  it('defaults to the last 30 days ending today, first page of 50', () => {
    const parsed = parse({});
    expect(parsed.ok && parsed.value.from.toString()).toBe('2026-10-18');
    expect(parsed.ok && parsed.value.to.toString()).toBe('2026-11-16');
    expect(parsed.ok && [parsed.value.page, parsed.value.pageSize]).toEqual([1, 50]);
  });

  it('takes a range, a lone `to` (30 days back) and paging', () => {
    const range = parse({ from: '2026-11-01', to: '2026-11-03', page: '2', pageSize: '10' });
    expect(range.ok && range.value.from.toString()).toBe('2026-11-01');
    expect(range.ok && [range.value.page, range.value.pageSize]).toEqual([2, 10]);
    const lone = parse({ to: '2026-11-30' });
    expect(lone.ok && lone.value.from.toString()).toBe('2026-11-01');
  });

  it('allows 92 days and refuses 93', () => {
    expect(parse({ from: '2026-08-16', to: '2026-11-15' }).ok).toBe(true);
    expect(parse({ from: '2026-08-15', to: '2026-11-15' })).toEqual({
      ok: false,
      error: [{ path: 'to', code: 'range' }],
    });
  });

  it.each([
    [{ from: '2026-11-05', to: '2026-11-01' }, 'from', 'range'],
    [{ from: '2026-02-30' }, 'from', 'format'],
    [{ from: '16/11/2026' }, 'from', 'format'],
    [{ to: ['2026-11-01'] }, 'to', 'format'],
    [{ page: '0' }, 'page', 'range'],
    [{ page: 'x' }, 'page', 'range'],
    [{ pageSize: '101' }, 'pageSize', 'range'],
    [{ sort: 'count' }, 'sort', 'format'],
  ])('refuses %j', (query, path, code) => {
    expect(parse(query)).toEqual({ ok: false, error: [{ path, code }] });
  });
});
