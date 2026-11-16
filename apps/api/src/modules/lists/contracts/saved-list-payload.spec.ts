import { canonicalQuery, savedListPayloadParser, type ListQueryField } from './saved-list-payload';

// The closed saved-filter document of a query-driven list (super list phase 4, PR10): the shape
// is refused here before the list's own reader sees anything; the stored form is canonical.

/** A list's own reader as the phase 4 lists have one: `q` trimmed, `colour` from a closed set. */
function read(query: Readonly<Record<string, string>>) {
  const fields: ListQueryField[] = [];
  const colour = query['colour'];
  if (colour !== undefined && !['red', 'blue'].includes(colour)) {
    fields.push({ path: 'colour', code: 'value' });
  }
  const q = query['q']?.trim() ?? null;
  return {
    fields,
    canonical: canonicalQuery({ q: q === '' ? null : q, colour: colour ?? null }),
  };
}

const WITH_VIEWS = savedListPayloadParser({
  views: ['all', 'open'],
  filterKeys: ['colour', 'search'],
  sorts: ['created'],
  read,
});
const NO_VIEWS = savedListPayloadParser({
  views: null,
  filterKeys: ['colour'],
  sorts: ['created'],
  read,
});
const BASE = { v: 1, view: 'all', sort: 'created', direction: 'desc' } as const;
const fieldsOf = (result: ReturnType<typeof WITH_VIEWS>) =>
  result.ok ? null : result.error.fields;

describe('savedListPayloadParser', () => {
  it.each([[null], ['{}'], [1], [[]], [[BASE]]])(
    'refuses a payload that is no object: %p',
    (raw) => {
      expect(fieldsOf(WITH_VIEWS(raw))).toEqual([{ path: 'payload', code: 'type' }]);
    },
  );

  it.each([
    [
      '{"v":1,"view":"all","sort":"created","direction":"desc","__proto__":{"x":1}}',
      'payload.__proto__',
    ],
    [
      '{"v":1,"view":"all","sort":"created","direction":"desc","constructor":"x"}',
      'payload.constructor',
    ],
    [
      '{"v":1,"view":"all","sort":"created","direction":"desc","filters":{"__proto__":"red"}}',
      'payload.filters.__proto__',
    ],
    [
      '{"v":1,"view":"all","sort":"created","direction":"desc","filters":{"constructor":"red"}}',
      'payload.filters.constructor',
    ],
  ])('refuses an own prototype key from JSON: %s', (text, path) => {
    expect(fieldsOf(WITH_VIEWS(JSON.parse(text)))).toEqual([{ path, code: 'unknown' }]);
  });

  it('refuses a view on a list that has none, and requires it on a list that has views', () => {
    expect(fieldsOf(NO_VIEWS(BASE))).toEqual([{ path: 'payload.view', code: 'unknown' }]);
    const withoutView = { v: 1, sort: 'created', direction: 'desc' } as const;
    expect(fieldsOf(WITH_VIEWS(withoutView))).toEqual([{ path: 'payload.view', code: 'required' }]);
    expect(NO_VIEWS(withoutView)).toEqual({ ok: true, value: { ...withoutView, filters: {} } });
  });

  it.each([
    [{ ...BASE, q: null }, 'payload.q'],
    [{ ...BASE, q: 5 }, 'payload.q'],
    [{ ...BASE, q: ['a'] }, 'payload.q'],
    [{ ...BASE, filters: null }, 'payload.filters'],
    [{ ...BASE, filters: ['red'] }, 'payload.filters'],
    [{ ...BASE, filters: { colour: null } }, 'payload.filters.colour'],
    [{ ...BASE, filters: { colour: true } }, 'payload.filters.colour'],
    [{ ...BASE, filters: { colour: { red: 1 } } }, 'payload.filters.colour'],
    [{ ...BASE, view: null }, 'payload.view'],
  ])('refuses a value of the wrong type, null included (%#)', (raw, path) => {
    expect(fieldsOf(WITH_VIEWS(raw))).toEqual([{ path, code: 'type' }]);
  });

  it.each([
    [{ ...BASE, q: 'a\u0000b' }, 'payload.q'],
    [{ ...BASE, q: 'line\nbreak' }, 'payload.q'],
    [{ ...BASE, q: 'bell\u0007' }, 'payload.q'],
    [{ ...BASE, q: 'private' }, 'payload.q'],
    [{ ...BASE, q: 'lone\uD800' }, 'payload.q'],
    [{ ...BASE, filters: { search: 'tab\there' } }, 'payload.filters.search'],
    [{ ...BASE, filters: { colour: 'red\u007F' } }, 'payload.filters.colour'],
  ])('refuses control, private-use, surrogate and unassigned characters (%#)', (raw, path) => {
    expect(fieldsOf(WITH_VIEWS(raw))).toEqual([{ path, code: 'format' }]);
  });

  it('keeps format characters such as the zero-width non-joiner', () => {
    const result = WITH_VIEWS({ ...BASE, q: 'گوشت‌حلال' });
    expect(result.ok && result.value.q).toBe('گوشت‌حلال');
  });

  it('drops a whitespace-only or empty q and filter value', () => {
    expect(WITH_VIEWS({ ...BASE, q: '   ', filters: { colour: '  ', search: '' } })).toEqual({
      ok: true,
      value: { ...BASE, filters: {} },
    });
  });

  it('maps a refusal of the list reader to the payload path', () => {
    expect(fieldsOf(WITH_VIEWS({ ...BASE, filters: { colour: 'green' } }))).toEqual([
      { path: 'payload.filters.colour', code: 'value' },
    ]);
  });

  it('refuses a wrong version, sort or direction', () => {
    expect(fieldsOf(WITH_VIEWS({ ...BASE, v: 2 }))).toEqual([{ path: 'payload.v', code: 'value' }]);
    expect(fieldsOf(WITH_VIEWS({ ...BASE, sort: 'name' }))).toEqual([
      { path: 'payload.sort', code: 'value' },
    ]);
    expect(fieldsOf(WITH_VIEWS({ ...BASE, direction: 'up' }))).toEqual([
      { path: 'payload.direction', code: 'value' },
    ]);
  });

  it('stores the canonical form, which parses again to the same result', () => {
    const first = WITH_VIEWS({ ...BASE, view: 'open', q: '  lamb  ', filters: { colour: 'blue' } });
    expect(first).toEqual({
      ok: true,
      value: { ...BASE, view: 'open', q: 'lamb', filters: { colour: 'blue' } },
    });
    if (!first.ok) throw new Error('refused');
    expect(WITH_VIEWS(first.value)).toEqual(first);
    expect(WITH_VIEWS(JSON.parse(JSON.stringify(first.value)))).toEqual(first);
  });
});
