import { closedListPayloadParser, SAVED_DATE_PRESETS } from './closed-list-payload';

// The closed saved-filter document shared by the lists that save a view, filters, a sort and a
// direction: shape, refusals and the canonical form.

const parse = closedListPayloadParser({
  views: ['all', 'open'],
  defaultView: 'all',
  filters: [
    ['code', { kind: 'text', pattern: /^[a-z]{1,8}$/ }],
    ['when', { kind: 'word', values: SAVED_DATE_PRESETS }],
    ['late', { kind: 'flag' }],
  ],
  sorts: ['made', 'name'],
  check: (payload) =>
    payload.filters?.['late'] === true && payload.view !== 'open'
      ? [{ path: 'payload.filters.late', code: 'outside-view' }]
      : [],
});

const fieldsOf = (result: ReturnType<typeof parse>) => (result.ok ? null : result.error.fields);

describe('closedListPayloadParser', () => {
  it('keeps a full document in its canonical form, and reads it back the same', () => {
    const result = parse({
      direction: 'desc',
      sort: 'name',
      filters: { late: true, when: 'last-7-days', code: 'abc' },
      view: 'open',
      v: 1,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'open',
        filters: { code: 'abc', when: 'last-7-days', late: true },
        sort: 'name',
        direction: 'desc',
      },
    });
    if (result.ok) expect(parse(result.value)).toEqual(result);
  });

  it('fills the default view and leaves empty parts out', () => {
    expect(
      parse({
        v: 1,
        filters: { code: '', when: null, late: false },
        sort: null,
        direction: null,
      }),
    ).toEqual({ ok: true, value: { v: 1, view: 'all' } });
    expect(parse({ v: 1, filters: null })).toEqual({ ok: true, value: { v: 1, view: 'all' } });
  });

  it.each([
    [null, 'payload', 'type'],
    [[], 'payload', 'type'],
    ['{"v":1}', 'payload', 'type'],
    [{ v: 1, q: 'text' }, 'payload.q', 'unknown'],
    [{ v: 1, page: 2 }, 'payload.page', 'unknown'],
    [{ v: 1, columns: ['a'] }, 'payload.columns', 'unknown'],
    [{ v: 1, tab: 'all' }, 'payload.tab', 'unknown'],
    [JSON.parse('{"v":1,"__proto__":{"x":1}}') as unknown, 'payload.__proto__', 'unknown'],
    [{ view: 'all' }, 'payload.v', 'value'],
    [{ v: '1' }, 'payload.v', 'value'],
    [{ v: 2 }, 'payload.v', 'value'],
    [{ v: 1, view: 'closed' }, 'payload.view', 'value'],
    [{ v: 1, view: 3 }, 'payload.view', 'type'],
    [{ v: 1, filters: 'code' }, 'payload.filters', 'type'],
    [{ v: 1, filters: ['code'] }, 'payload.filters', 'type'],
    [{ v: 1, filters: { other: 'x' } }, 'payload.filters.other', 'unknown'],
    [
      { v: 1, filters: JSON.parse('{"__proto__":"x"}') as unknown },
      'payload.filters.__proto__',
      'unknown',
    ],
    [{ v: 1, filters: { code: 'ABC' } }, 'payload.filters.code', 'format'],
    [{ v: 1, filters: { code: 'abcdefghi' } }, 'payload.filters.code', 'format'],
    [{ v: 1, filters: { code: 7 } }, 'payload.filters.code', 'type'],
    [{ v: 1, filters: { when: '2026-11-01' } }, 'payload.filters.when', 'value'],
    [{ v: 1, filters: { late: 'true' } }, 'payload.filters.late', 'type'],
    [{ v: 1, sort: 'id' }, 'payload.sort', 'value'],
    [{ v: 1, direction: 'up' }, 'payload.direction', 'value'],
    [{ v: 1, direction: 1 }, 'payload.direction', 'type'],
    [{ v: 1, view: 'all', filters: { late: true } }, 'payload.filters.late', 'outside-view'],
  ])('refuses %j at %s (%s)', (raw, path, code) => {
    expect(fieldsOf(parse(raw))).toEqual([{ path, code }]);
  });
});
