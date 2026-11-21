import { Temporal } from '@mondapac/shared-kernel';
import {
  instantBoundDate,
  instantRangeWhere,
  parseClosedValues,
  parseInstantRange,
  parseNamedInstantRange,
} from './instant-range';

describe('the instant range of a list filter', () => {
  it('reads ISO instants with an offset, from inclusive and to exclusive', () => {
    const range = parseInstantRange({
      from: '2026-11-01T00:00:00+10:00',
      to: '2026-11-02T00:00:00+09:00',
    });
    expect(
      range.ok && range.value.from?.equals(Temporal.Instant.from('2026-10-31T14:00:00Z')),
    ).toBe(true);
    expect(range.ok && range.value.to?.equals(Temporal.Instant.from('2026-11-01T15:00:00Z'))).toBe(
      true,
    );
    expect(parseInstantRange({})).toEqual({ ok: true, value: { from: null, to: null } });
  });

  it('refuses a bare day, junk and a range that ends before it starts', () => {
    const code = (record: Record<string, unknown>) => {
      const range = parseInstantRange(record);
      return range.ok ? 'ok' : range.error.fields[0];
    };
    expect(code({ from: '2026-11-01' })).toEqual({ path: 'filters.from', code: 'format' });
    expect(code({ to: 42 })).toEqual({ path: 'filters.to', code: 'format' });
    expect(code({ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' })).toEqual({
      path: 'filters.to',
      code: 'range',
    });
  });

  it('reads a closed list of values once each, and refuses unknown or empty ones', () => {
    const allowed = ['a', 'b'] as const;
    expect(parseClosedValues(['b', 'b'], allowed, 'filters.x')).toEqual({ ok: true, value: ['b'] });
    expect(parseClosedValues(undefined, allowed, 'filters.x')).toEqual({ ok: true, value: null });
    expect(parseClosedValues([], allowed, 'filters.x').ok).toBe(false);
    expect(parseClosedValues(['c'], allowed, 'filters.x').ok).toBe(false);
    expect(parseClosedValues('a', allowed, 'filters.x').ok).toBe(false);
  });
});

describe('the named instant range of a list filter', () => {
  it('names the failing key and keeps from inclusive, to exclusive', () => {
    const bad = parseNamedInstantRange({ createdFrom: '2026-11-01' }, 'createdFrom', 'createdTo');
    expect(!bad.ok && bad.error.fields).toEqual([{ path: 'createdFrom', code: 'format' }]);
    const backwards = parseNamedInstantRange(
      { submittedFrom: '2026-11-02T00:00:00Z', submittedTo: '2026-11-01T00:00:00Z' },
      'submittedFrom',
      'submittedTo',
    );
    expect(!backwards.ok && backwards.error.fields).toEqual([
      { path: 'submittedTo', code: 'range' },
    ]);
    const ok = parseNamedInstantRange(
      { createdFrom: '2026-11-01T00:00:00+10:00', createdTo: '' },
      'createdFrom',
      'createdTo',
    );
    expect(ok.ok && instantRangeWhere(ok.value)).toEqual({ gte: new Date('2026-10-31T14:00:00Z') });
    expect(instantRangeWhere({ from: null, to: null })).toBeUndefined();
  });

  it('rounds a sub-millisecond bound up to the millisecond', () => {
    expect(instantBoundDate(Temporal.Instant.from('2026-11-01T00:00:00.0005Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.001Z',
    );
  });
});
